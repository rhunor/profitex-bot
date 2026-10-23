import { getEnv } from '../config/env';
import { createLogger } from '../utils/logger';
import { connectToDatabase } from '../db/connect';
import { processReminders, type ReminderReport } from './reminders';
import { processExpirations, type ExpiryReport } from './expiry';
import { reconcilePendingPayments, reconcileUnfulfilledPayments, type PendingSweepReport } from '../services/payment.service';
import { expireStaleLinks } from '../services/invite.service';
import { processBroadcastQueue, type BroadcastPassReport } from '../services/broadcast.service';

const log = createLogger('scheduler');

/** Reserved at the end of the budget so the final counts and the HTTP response always fit. */
const WRAP_UP_MS = 4_000;

export interface SchedulerReport {
  startedAt: string;
  durationMs: number;
  reminders: ReminderReport;
  expiry: ExpiryReport;
  reconciledPayments: number;
  pendingSweep: PendingSweepReport;
  staleLinksExpired: number;
  broadcast: BroadcastPassReport;
  /** True when something was left unfinished and a follow-up pass is warranted. */
  hasMoreWork: boolean;
  errors: string[];
}

export interface SchedulerOptions {
  /** Wall-clock budget for the whole pass. Must fit inside the host's execution limit. */
  budgetMs?: number;
  includeBroadcast?: boolean;
  broadcastBudgetMs?: number;
}

let running = false;

function emptyReport(startedAt: Date, errors: string[]): SchedulerReport {
  return {
    startedAt: startedAt.toISOString(),
    durationMs: 0,
    reminders: { considered: 0, sent: 0, skipped: 0, failed: 0, remaining: 0, byKey: { d7: 0, d3: 0, h24: 0 } },
    expiry: { due: 0, removed: 0, removalFailed: 0, notified: 0, remaining: 0 },
    reconciledPayments: 0,
    pendingSweep: { checked: 0, rescued: 0, abandoned: 0 },
    staleLinksExpired: 0,
    broadcast: { processed: 0, sent: 0, failed: 0, remaining: 0, activeJobs: 0 },
    hasMoreWork: false,
    errors,
  };
}

/**
 * One full maintenance pass, bounded by a wall-clock budget.
 *
 * Ordered deliberately: reminders first (so a subscriber is always warned
 * before removal), then removals, then the safety nets, then outbound
 * broadcast traffic with whatever time is left.
 *
 * Every step is resumable. If the budget runs out, the report's `hasMoreWork`
 * flag tells the caller to trigger a follow-up pass — which is what lets a
 * host with a once-a-day scheduler and a per-invocation time limit still clear
 * an arbitrarily large backlog.
 */
export async function runScheduledWork(options: SchedulerOptions = {}): Promise<SchedulerReport> {
  const env = getEnv();
  const startedAt = new Date();
  const errors: string[] = [];
  const report = emptyReport(startedAt, errors);

  if (running) {
    errors.push('A scheduler pass is already running in this process; skipped.');
    return report;
  }

  const budgetMs = options.budgetMs ?? env.SCHEDULER_BUDGET_MS;
  // Reserve the wrap-up window, but never invert the deadline. A budget smaller
  // than the reserve is honoured as-is: the pass does nothing, reports
  // `hasMoreWork`, and a follow-up runs rather than overrunning the host.
  const deadline = startedAt.getTime() + Math.max(budgetMs - WRAP_UP_MS, Math.min(budgetMs, 1_000));
  const timeLeft = (): number => deadline - Date.now();

  running = true;
  try {
    await connectToDatabase();

    const steps: Array<[string, () => Promise<void>]> = [
      ['reminders', async () => {
        report.reminders = await processReminders(startedAt, { deadline });
      }],
      ['expiry', async () => {
        report.expiry = await processExpirations(startedAt, { deadline });
      }],
      ['reconcile', async () => {
        report.reconciledPayments = await reconcileUnfulfilledPayments();
      }],
      // Catches payments the gateway never told us about.
      ['pending-payments', async () => {
        report.pendingSweep = await reconcilePendingPayments();
      }],
      ['stale-links', async () => {
        report.staleLinksExpired = await expireStaleLinks();
      }],
    ];

    if (options.includeBroadcast !== false) {
      steps.push(['broadcast', async () => {
        // Broadcasts get whatever is left, capped by their own budget.
        const available = Math.min(timeLeft(), options.broadcastBudgetMs ?? env.BROADCAST_BUDGET_MS);
        if (available < 1_000) {
          report.broadcast.remaining = 1; // unknown but non-zero; forces a follow-up
          return;
        }
        report.broadcast = await processBroadcastQueue(available);
      }]);
    }

    // Each step is isolated: one failing area must not stop the others.
    for (const [name, step] of steps) {
      if (timeLeft() <= 0) {
        errors.push(`${name}: skipped, out of time`);
        report.hasMoreWork = true;
        continue;
      }
      try {
        await step();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${name}: ${message}`);
        log.error(`Scheduler step "${name}" failed`, error);
      }
    }

    report.hasMoreWork =
      report.hasMoreWork ||
      report.reminders.remaining > 0 ||
      report.expiry.remaining > 0 ||
      report.broadcast.remaining > 0;
  } finally {
    running = false;
    report.durationMs = Date.now() - startedAt.getTime();
  }

  log.info('Scheduler pass finished', {
    durationMs: report.durationMs,
    remindersSent: report.reminders.sent,
    paymentsRescued: report.pendingSweep.rescued,
    removed: report.expiry.removed,
    broadcastSent: report.broadcast.sent,
    hasMoreWork: report.hasMoreWork,
    errors: errors.length,
  });

  return report;
}
