import { createLogger } from '../utils/logger';
import { DAY, HOUR } from '../utils/time';
import { Subscription, type ISubscription, type ReminderKey } from '../models';
import { notifyReminder } from '../services/notify.service';

const log = createLogger('job:reminders');

/**
 * Which reminder a subscription is due, based purely on how far its end date is
 * from now. Reading the state rather than pre-scheduling alarms is what makes a
 * renewal or a manual extension self-correcting: the next pass simply sees a
 * different end date and stops reminding.
 *
 * Because the windows are *ranges* rather than exact points, a scheduler that
 * runs only once a day still hits every one of them.
 */
export function dueReminder(subscription: ISubscription, now: Date = new Date()): ReminderKey | null {
  const remaining = subscription.expiresAt.getTime() - now.getTime();
  if (remaining <= 0) return null;

  if (remaining <= 24 * HOUR) return 'h24';
  if (remaining <= 3 * DAY) return 'd3';
  if (remaining <= 7 * DAY) return 'd7';
  return null;
}

/**
 * Subscriptions sitting in a reminder window that has not been delivered yet.
 *
 * Expressed as a query rather than a scan so the job's cost tracks the number
 * of people who actually need messaging, not the size of the member list.
 * The three clauses mirror `dueReminder` exactly — `null` matches a field that
 * is absent as well as one explicitly cleared by a renewal.
 */
function pendingReminderFilter(now: Date): Record<string, unknown> {
  const in24h = new Date(now.getTime() + 24 * HOUR);
  const in3d = new Date(now.getTime() + 3 * DAY);
  const in7d = new Date(now.getTime() + 7 * DAY);

  return {
    status: 'active',
    $or: [
      { expiresAt: { $gt: now, $lte: in24h }, 'remindersSent.h24': null },
      { expiresAt: { $gt: in24h, $lte: in3d }, 'remindersSent.d3': null },
      { expiresAt: { $gt: in3d, $lte: in7d }, 'remindersSent.d7': null },
    ],
  };
}

export interface ReminderReport {
  considered: number;
  sent: number;
  skipped: number;
  failed: number;
  /** Still owed a reminder when this pass stopped. Drives the follow-up pass. */
  remaining: number;
  byKey: Record<ReminderKey, number>;
}

export interface ReminderOptions {
  /** `Date.now()` value this pass must finish by. */
  deadline?: number;
  /** Hard cap on how many subscriptions one pass will load. */
  batchSize?: number;
}

export async function processReminders(
  now: Date = new Date(),
  options: ReminderOptions = {},
): Promise<ReminderReport> {
  const { deadline = Number.POSITIVE_INFINITY, batchSize = 500 } = options;

  const report: ReminderReport = {
    considered: 0,
    sent: 0,
    skipped: 0,
    failed: 0,
    remaining: 0,
    byKey: { d7: 0, d3: 0, h24: 0 },
  };

  const filter = pendingReminderFilter(now);

  // Soonest expiry first: the people closest to losing access are warned even
  // if the pass runs out of time.
  const candidates = await Subscription.find(filter).sort({ expiresAt: 1 }).limit(batchSize);

  for (const subscription of candidates) {
    if (Date.now() >= deadline) break;

    report.considered += 1;

    const key = dueReminder(subscription, now);
    if (!key || subscription.remindersSent?.[key]) {
      report.skipped += 1;
      continue;
    }

    const delivered = await notifyReminder(subscription, key);

    // Recorded either way. A subscriber who blocked the bot should not have the
    // whole queue retried on every pass.
    await Subscription.updateOne(
      { _id: subscription._id },
      { $set: { [`remindersSent.${key}`]: new Date() } },
    );

    if (delivered) {
      report.sent += 1;
      report.byKey[key] += 1;
    } else {
      report.failed += 1;
    }
  }

  report.remaining = await Subscription.countDocuments(pendingReminderFilter(now));

  if (report.sent > 0 || report.failed > 0 || report.remaining > 0) {
    log.info('Reminder pass complete', report);
  }

  return report;
}
