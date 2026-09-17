import { createLogger } from '../utils/logger';
import { Subscription } from '../models';
import { removeMemberFromGroup } from '../services/telegram';
import { markExpired } from '../services/subscription.service';
import { notifyRemoval } from '../services/notify.service';
import { revokeActiveLinksFor } from '../services/invite.service';
import { setGroupMembership } from '../services/user.service';

const log = createLogger('job:expiry');

export interface ExpiryReport {
  due: number;
  removed: number;
  removalFailed: number;
  notified: number;
  /** Past their end date but not reached before this pass ran out of time. */
  remaining: number;
}

export interface ExpiryOptions {
  /** `Date.now()` value this pass must finish by. */
  deadline?: number;
  batchSize?: number;
}

/**
 * Removes every subscriber whose end date has passed, tells them why, and
 * leaves a one-tap path back in.
 *
 * Works in bounded batches so a single invocation can never run past its host's
 * execution limit. Anything it does not reach stays queued — the records are
 * still `active` with a past end date — and the follow-up pass picks it up.
 */
export async function processExpirations(
  now: Date = new Date(),
  options: ExpiryOptions = {},
): Promise<ExpiryReport> {
  const { deadline = Number.POSITIVE_INFINITY, batchSize = 200 } = options;

  const report: ExpiryReport = { due: 0, removed: 0, removalFailed: 0, notified: 0, remaining: 0 };

  const filter = { status: 'active' as const, expiresAt: { $lte: now } };

  // Longest expired first, so nobody lingers in the group across passes.
  const expired = await Subscription.find(filter).sort({ expiresAt: 1 }).limit(batchSize);

  for (const subscription of expired) {
    if (Date.now() >= deadline) break;

    report.due += 1;

    const removal = await removeMemberFromGroup(subscription.telegramId);

    if (removal.ok) {
      report.removed += 1;
      await setGroupMembership(subscription.telegramId, false);
    } else {
      report.removalFailed += 1;
      log.warn('Could not remove expired member', {
        telegramId: subscription.telegramId,
        error: removal.error,
      });
    }

    // Any link still floating around belongs to a subscription that is over.
    await revokeActiveLinksFor(subscription.telegramId);

    await markExpired(subscription, removal.ok);

    if (!subscription.removalNoticeSentAt) {
      const notified = await notifyRemoval(subscription);
      if (notified) {
        report.notified += 1;
        await Subscription.updateOne({ _id: subscription._id }, { $set: { removalNoticeSentAt: new Date() } });
      }
    }
  }

  report.remaining = await Subscription.countDocuments(filter);

  if (report.due > 0 || report.remaining > 0) log.info('Expiry pass complete', report);
  return report;
}
