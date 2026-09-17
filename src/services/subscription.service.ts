import type { Types } from 'mongoose';
import { addDays } from '../utils/time';
import { createLogger } from '../utils/logger';
import {
  Subscription,
  recordActivity,
  type IPlan,
  type IPlanSnapshot,
  type ISubscription,
  type IUser,
} from '../models';

const log = createLogger('subscriptions');

export function snapshotFromPlan(plan: IPlan): IPlanSnapshot {
  return {
    code: plan.code,
    name: plan.name,
    priceMinor: plan.priceMinor,
    currency: plan.currency,
    durationDays: plan.durationDays,
  };
}

export async function getActiveSubscription(telegramId: number): Promise<ISubscription | null> {
  return Subscription.findOne({ telegramId, status: 'active' });
}

export async function getLatestSubscription(telegramId: number): Promise<ISubscription | null> {
  return Subscription.findOne({ telegramId }).sort({ createdAt: -1 });
}

export interface ActivationInput {
  user: IUser;
  planSnapshot: IPlanSnapshot;
  planId?: Types.ObjectId;
  durationDays?: number;
  paymentReference?: string;
  source?: 'payment' | 'manual';
  notes?: string;
}

export interface ActivationResult {
  subscription: ISubscription;
  isRenewal: boolean;
  previousExpiry?: Date;
}

/**
 * The single place a subscription is created or extended.
 *
 * Renewing before expiry *extends* the existing end date rather than restarting
 * it, so a subscriber never loses days by paying early. The reminder flags are
 * cleared so the new cycle gets its own 7/3/1-day notices.
 */
export async function activateOrExtend(input: ActivationInput): Promise<ActivationResult> {
  const now = new Date();
  const durationDays = input.durationDays ?? input.planSnapshot.durationDays;
  const source = input.source ?? 'payment';

  const existing = await Subscription.findOne({ telegramId: input.user.telegramId, status: 'active' });

  if (existing) {
    const previousExpiry = existing.expiresAt;
    // If the record is stale (past its end date but not yet swept up by the
    // expiry job) start the new period from now instead of the past.
    const base = existing.expiresAt.getTime() > now.getTime() ? existing.expiresAt : now;

    existing.expiresAt = addDays(base, durationDays);
    existing.planSnapshot = input.planSnapshot;
    if (input.planId) existing.plan = input.planId;
    existing.cycleStartedAt = now;
    existing.remindersSent = {};
    existing.removalNoticeSentAt = undefined;
    existing.renewalCount += 1;
    existing.source = source;
    if (input.paymentReference) existing.lastPaymentReference = input.paymentReference;
    if (input.notes) existing.notes = input.notes;
    await existing.save();

    recordActivity({
      action: 'subscription.renewed',
      telegramId: input.user.telegramId,
      message: `Extended to ${existing.expiresAt.toISOString()}`,
      meta: { plan: input.planSnapshot.code, previousExpiry, reference: input.paymentReference },
    });

    log.info('Subscription extended', {
      telegramId: input.user.telegramId,
      expiresAt: existing.expiresAt,
    });

    return { subscription: existing, isRenewal: true, previousExpiry };
  }

  const doc = {
    user: input.user._id as Types.ObjectId,
    telegramId: input.user.telegramId,
    plan: input.planId,
    planSnapshot: input.planSnapshot,
    status: 'active' as const,
    startsAt: now,
    expiresAt: addDays(now, durationDays),
    cycleStartedAt: now,
    remindersSent: {},
    lastPaymentReference: input.paymentReference,
    source,
    renewalCount: 0,
    notes: input.notes,
  };

  try {
    const created = await Subscription.create(doc);
    recordActivity({
      action: 'subscription.activated',
      telegramId: input.user.telegramId,
      message: `Active until ${created.expiresAt.toISOString()}`,
      meta: { plan: input.planSnapshot.code, reference: input.paymentReference },
    });
    log.info('Subscription activated', { telegramId: input.user.telegramId, expiresAt: created.expiresAt });
    return { subscription: created, isRenewal: false };
  } catch (error) {
    // Lost a race against a concurrent activation: the unique partial index on
    // (telegramId, status: active) rejected us. Retry as an extension.
    if ((error as { code?: number }).code === 11000) {
      log.warn('Concurrent activation detected, extending instead', { telegramId: input.user.telegramId });
      return activateOrExtend(input);
    }
    throw error;
  }
}

export async function markExpired(subscription: ISubscription, removedFromGroup: boolean): Promise<ISubscription> {
  subscription.status = 'expired';
  if (removedFromGroup) subscription.removedFromGroupAt = new Date();
  await subscription.save();

  recordActivity({
    action: 'subscription.expired',
    telegramId: subscription.telegramId,
    message: `Expired on ${subscription.expiresAt.toISOString()}`,
    meta: { removedFromGroup },
  });

  return subscription;
}

export async function revokeSubscription(
  subscription: ISubscription,
  actorTelegramId?: number,
  reason?: string,
): Promise<ISubscription> {
  subscription.status = 'revoked';
  subscription.removedFromGroupAt = new Date();
  if (reason) subscription.notes = reason;
  await subscription.save();

  recordActivity({
    action: 'subscription.revoked',
    telegramId: subscription.telegramId,
    actorTelegramId,
    message: reason,
  });

  return subscription;
}

export interface SubscriptionStats {
  activeCount: number;
  expiringIn7Days: number;
  expiredCount: number;
  totalSubscribers: number;
}

export async function getSubscriptionStats(): Promise<SubscriptionStats> {
  const now = new Date();
  const [activeCount, expiringIn7Days, expiredCount, totalSubscribers] = await Promise.all([
    Subscription.countDocuments({ status: 'active' }),
    Subscription.countDocuments({ status: 'active', expiresAt: { $lte: addDays(now, 7), $gt: now } }),
    Subscription.countDocuments({ status: { $in: ['expired', 'revoked'] } }),
    Subscription.distinct('telegramId').then((ids) => ids.length),
  ]);

  return { activeCount, expiringIn7Days, expiredCount, totalSubscribers };
}
