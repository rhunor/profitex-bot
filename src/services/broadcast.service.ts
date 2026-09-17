import type { Types } from 'mongoose';
import { getEnv } from '../config/env';
import { createLogger } from '../utils/logger';
import { sleep } from '../utils/time';
import {
  Broadcast,
  BroadcastTarget,
  Subscription,
  User,
  recordActivity,
  type BroadcastAudience,
  type IBroadcast,
} from '../models';
import { copyMessageSafe } from './telegram';
import { markUnreachable } from './user.service';

const log = createLogger('broadcast');

/** Telegram user ids that should receive a broadcast for the chosen audience. */
export async function resolveAudience(audience: BroadcastAudience): Promise<number[]> {
  if (audience === 'active') {
    const ids = await Subscription.find({ status: 'active', expiresAt: { $gt: new Date() } })
      .distinct('telegramId');
    const reachable = await User.find({ telegramId: { $in: ids }, hasBlockedBot: { $ne: true } })
      .select('telegramId')
      .lean();
    return reachable.map((u) => u.telegramId);
  }

  if (audience === 'expired') {
    const activeIds = await Subscription.find({ status: 'active', expiresAt: { $gt: new Date() } })
      .distinct('telegramId');
    const everSubscribed = await Subscription.find({}).distinct('telegramId');
    const lapsed = everSubscribed.filter((id: number) => !activeIds.includes(id));
    const reachable = await User.find({ telegramId: { $in: lapsed }, hasBlockedBot: { $ne: true } })
      .select('telegramId')
      .lean();
    return reachable.map((u) => u.telegramId);
  }

  const all = await User.find({ hasBlockedBot: { $ne: true } }).select('telegramId').lean();
  return all.map((u) => u.telegramId);
}

export interface CreateBroadcastInput {
  createdByTelegramId: number;
  audience: BroadcastAudience;
  sourceChatId: number;
  sourceMessageId: number;
  preview: string;
}

export async function createBroadcast(input: CreateBroadcastInput): Promise<{ broadcast: IBroadcast; total: number }> {
  const recipients = await resolveAudience(input.audience);

  const broadcast = await Broadcast.create({
    createdByTelegramId: input.createdByTelegramId,
    audience: input.audience,
    mode: 'copy',
    sourceChatId: input.sourceChatId,
    sourceMessageId: input.sourceMessageId,
    preview: input.preview.slice(0, 200),
    total: recipients.length,
    status: 'queued',
  });

  if (recipients.length > 0) {
    // Queued as individual rows so a crash mid-send never re-messages anyone.
    await BroadcastTarget.insertMany(
      recipients.map((telegramId) => ({
        broadcast: broadcast._id as Types.ObjectId,
        telegramId,
        status: 'pending' as const,
      })),
      { ordered: false },
    ).catch((error) => {
      if ((error as { code?: number }).code !== 11000) throw error;
    });
  }

  recordActivity({
    action: 'broadcast.created',
    actorTelegramId: input.createdByTelegramId,
    message: `${input.audience} → ${recipients.length} recipient(s)`,
    meta: { broadcastId: String(broadcast._id) },
  });

  return { broadcast, total: recipients.length };
}

export interface BroadcastPassReport {
  processed: number;
  sent: number;
  failed: number;
  remaining: number;
  activeJobs: number;
}

/**
 * Drains queued broadcasts at a Telegram-safe rate, for at most `budgetMs`.
 *
 * Designed to be re-entered: whatever is left stays queued and the next
 * scheduler pass (or self-chained call) continues from where this one stopped.
 */
export async function processBroadcastQueue(budgetMs?: number): Promise<BroadcastPassReport> {
  const env = getEnv();
  const budget = budgetMs ?? env.BROADCAST_BUDGET_MS;
  const deadline = Date.now() + budget;
  const gapMs = Math.ceil(1000 / env.BROADCAST_RATE_PER_SEC);

  const report: BroadcastPassReport = { processed: 0, sent: 0, failed: 0, remaining: 0, activeJobs: 0 };

  const jobs = await Broadcast.find({ status: { $in: ['queued', 'running'] } }).sort({ createdAt: 1 });
  report.activeJobs = jobs.length;

  for (const job of jobs) {
    if (Date.now() >= deadline) break;

    if (job.status === 'queued') {
      job.status = 'running';
      job.startedAt = job.startedAt ?? new Date();
      await job.save();
    }

    for (;;) {
      if (Date.now() >= deadline) break;

      // Claim one recipient atomically so parallel workers cannot collide.
      const target = await BroadcastTarget.findOneAndUpdate(
        { broadcast: job._id, status: 'pending' },
        { $set: { status: 'sent', sentAt: new Date() }, $inc: { attempts: 1 } },
        { returnDocument: 'after', sort: { _id: 1 } },
      );
      if (!target) break;

      const outcome = await copyMessageSafe(target.telegramId, job.sourceChatId, job.sourceMessageId);
      report.processed += 1;

      if (outcome.ok) {
        report.sent += 1;
        await Broadcast.updateOne({ _id: job._id }, { $inc: { sent: 1 } });
      } else {
        report.failed += 1;
        await BroadcastTarget.updateOne(
          { _id: target._id },
          { $set: { status: 'failed', error: outcome.error?.slice(0, 300) } },
        );
        await Broadcast.updateOne({ _id: job._id }, { $inc: { failed: 1 } });
        if (outcome.unreachable) await markUnreachable(target.telegramId);
      }

      await sleep(gapMs);
    }

    const pending = await BroadcastTarget.countDocuments({ broadcast: job._id, status: 'pending' });
    if (pending === 0) {
      const finished = await Broadcast.findOneAndUpdate(
        { _id: job._id, status: 'running' },
        { $set: { status: 'done', finishedAt: new Date() } },
        { returnDocument: 'after' },
      );
      if (finished) {
        recordActivity({
          action: 'broadcast.finished',
          actorTelegramId: finished.createdByTelegramId,
          message: `${finished.sent} delivered, ${finished.failed} failed`,
          meta: { broadcastId: String(finished._id) },
        });
        await notifyOwner(finished);
      }
    } else {
      report.remaining += pending;
    }
  }

  if (report.processed > 0) {
    log.info('Broadcast pass complete', report);
  }

  return report;
}

async function notifyOwner(job: IBroadcast): Promise<void> {
  const { sendMessageSafe } = await import('./telegram');
  await sendMessageSafe(
    job.createdByTelegramId,
    [
      '\u{1F4E3} <b>Broadcast finished</b>',
      '',
      `Audience: <b>${job.audience}</b>`,
      `Delivered: <b>${job.sent}</b>`,
      `Failed: <b>${job.failed}</b> <i>(blocked the bot or never started a chat)</i>`,
      `Total queued: <b>${job.total}</b>`,
    ].join('\n'),
  );
}

export async function cancelBroadcast(broadcastId: string): Promise<boolean> {
  const job = await Broadcast.findById(broadcastId);
  if (!job || job.status === 'done') return false;
  job.status = 'cancelled';
  job.finishedAt = new Date();
  await job.save();
  await BroadcastTarget.deleteMany({ broadcast: job._id, status: 'pending' });
  return true;
}

export async function hasPendingWork(): Promise<boolean> {
  const count = await Broadcast.countDocuments({ status: { $in: ['queued', 'running'] } });
  return count > 0;
}
