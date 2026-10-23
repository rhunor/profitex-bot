import type { Types } from 'mongoose';
import { getEnv, publicUrl } from '../config/env';
import { createLogger } from '../utils/logger';
import { buildPaymentReference } from '../utils/reference';
import { displayName } from '../utils/text';
import {
  Payment,
  Plan,
  recordActivity,
  type Gateway,
  type IInviteLink,
  type IPayment,
  type IPlan,
  type ISubscription,
  type IUser,
} from '../models';
import { getGateway } from './payments';
import { GatewayError } from './payments/types';
import { activateOrExtend, snapshotFromPlan } from './subscription.service';
import { issueInviteLink } from './invite.service';
import { notifyAccessGranted, notifyAdmins } from './notify.service';

const log = createLogger('payments');

/** A stale lock is reclaimed after this long, in case a worker died mid-fulfilment. */
const FULFILMENT_LOCK_MS = 2 * 60 * 1000;
/**
 * A checkout nobody completes stays "pending" forever and would be re-checked
 * on every sweep. After this long it is written off, which keeps the sweep
 * cheap. A late payment is still honoured: the webhook, or the subscriber
 * opening /status, verifies it regardless of the stored status.
 */
const ABANDON_PENDING_AFTER_MS = 6 * 60 * 60 * 1000;

/** Absorbs sub-kobo rounding when converting gateway major units back to minor. */
const AMOUNT_TOLERANCE_MINOR = 1;

export interface InitiateInput {
  user: IUser;
  plan: IPlan;
  gateway: Gateway;
  email: string;
}

export interface InitiateResult {
  payment: IPayment;
  checkoutUrl: string;
}

/**
 * Creates the payment record *first*, then asks the gateway for a checkout
 * link. An abandoned checkout is therefore visible in the admin's payment
 * history rather than invisible.
 */
export async function initiatePayment(input: InitiateInput): Promise<InitiateResult> {
  const env = getEnv();
  if (!env.PUBLIC_URL) {
    throw new GatewayError(
      'PUBLIC_URL is not configured, so payment redirects cannot be built.',
      input.gateway,
    );
  }

  const reference = buildPaymentReference(input.user.telegramId);

  const payment = await Payment.create({
    reference,
    gateway: input.gateway,
    user: input.user._id as Types.ObjectId,
    telegramId: input.user.telegramId,
    plan: input.plan._id as Types.ObjectId,
    planCode: input.plan.code,
    planName: input.plan.name,
    amountMinor: input.plan.priceMinor,
    currency: input.plan.currency,
    email: input.email,
    status: 'pending',
  });

  const gateway = getGateway(input.gateway);

  try {
    const checkout = await gateway.createCheckout({
      reference,
      amountMinor: input.plan.priceMinor,
      currency: input.plan.currency,
      email: input.email,
      customerName: displayName({
        firstName: input.user.firstName,
        lastName: input.user.lastName,
        username: input.user.username,
        telegramId: input.user.telegramId,
      }),
      planName: input.plan.name,
      callbackUrl: publicUrl(`/api/payment/callback?reference=${encodeURIComponent(reference)}`),
      metadata: {
        telegram_id: input.user.telegramId,
        plan_code: input.plan.code,
        reference,
      },
    });

    payment.checkoutUrl = checkout.checkoutUrl;
    if (checkout.gatewayReference) payment.gatewayReference = checkout.gatewayReference;
    await payment.save();

    recordActivity({
      action: 'payment.initiated',
      telegramId: input.user.telegramId,
      message: `${input.gateway} checkout for ${input.plan.name}`,
      meta: { reference },
    });

    return { payment, checkoutUrl: checkout.checkoutUrl };
  } catch (error) {
    payment.status = 'failed';
    payment.failureReason = error instanceof Error ? error.message : String(error);
    await payment.save();
    throw error;
  }
}

export type FinalizeOutcome =
  | 'fulfilled'
  | 'already_fulfilled'
  | 'in_progress'
  | 'pending'
  | 'failed'
  | 'amount_mismatch'
  | 'unknown_reference';

export interface FinalizeResult {
  outcome: FinalizeOutcome;
  payment?: IPayment;
  subscription?: ISubscription;
  inviteLink?: IInviteLink | null;
  isRenewal?: boolean;
  reason?: string;
}

/**
 * Confirms a payment with the gateway and, exactly once, turns it into access.
 *
 * Safe to call from anywhere and any number of times: the webhook, the browser
 * redirect, the "I have paid" button and the reconciliation job all funnel
 * through here. Two database-level guards make repeat calls harmless —
 * the status transition and the fulfilment lock.
 */
export async function finalizePayment(
  reference: string,
  options: { gatewayReference?: string; trigger?: string } = {},
): Promise<FinalizeResult> {
  const payment = await Payment.findOne({ reference });
  if (!payment) {
    log.warn('Finalize called for unknown reference', { reference, trigger: options.trigger });
    return { outcome: 'unknown_reference' };
  }

  if (payment.status === 'success' && payment.fulfilledAt) {
    return { outcome: 'already_fulfilled', payment };
  }

  const gateway = getGateway(payment.gateway);
  const verification = await gateway.verify(reference, options.gatewayReference ?? payment.gatewayReference);

  log.info('Verified payment with gateway', {
    reference,
    gateway: payment.gateway,
    status: verification.status,
    trigger: options.trigger,
  });

  await Payment.updateOne({ _id: payment._id }, { $set: { lastVerifiedAt: new Date() } });

  if (verification.status === 'pending') {
    // Old enough that the customer has clearly walked away from the checkout.
    if (payment.status === 'pending' && Date.now() - payment.createdAt.getTime() > ABANDON_PENDING_AFTER_MS) {
      await Payment.updateOne(
        { _id: payment._id, status: 'pending' },
        { $set: { status: 'abandoned', failureReason: 'Checkout was never completed' } },
      );
    }
    return { outcome: 'pending', payment };
  }

  if (verification.status === 'failed' || verification.status === 'not_found') {
    // Only downgrade a record that has not already succeeded.
    await Payment.updateOne(
      { _id: payment._id, status: 'pending' },
      {
        $set: {
          status: verification.status === 'not_found' ? 'abandoned' : 'failed',
          failureReason: verification.reason ?? verification.status,
          verificationPayload: verification.raw,
        },
      },
    );
    recordActivity({
      action: 'payment.failed',
      telegramId: payment.telegramId,
      message: verification.reason ?? verification.status,
      meta: { reference },
    });
    return { outcome: 'failed', payment, reason: verification.reason };
  }

  // Independent amount + currency check. Never grant on a short payment.
  const currencyMatches = verification.currency.toUpperCase() === payment.currency.toUpperCase();
  const amountSufficient = verification.amountMinor + AMOUNT_TOLERANCE_MINOR >= payment.amountMinor;

  if (!currencyMatches || !amountSufficient) {
    const reason = `Expected ${payment.amountMinor} ${payment.currency}, gateway reported ${verification.amountMinor} ${verification.currency}`;
    await Payment.updateOne(
      { _id: payment._id },
      { $set: { status: 'failed', failureReason: reason, verificationPayload: verification.raw } },
    );
    log.error('Payment amount mismatch', { reference, reason });
    recordActivity({ action: 'payment.failed', telegramId: payment.telegramId, message: reason, meta: { reference } });
    return { outcome: 'amount_mismatch', payment, reason };
  }

  // Record the successful verification (idempotent — safe to repeat).
  await Payment.updateOne(
    { _id: payment._id },
    {
      $set: {
        status: 'success',
        paidAmountMinor: verification.amountMinor,
        paidCurrency: verification.currency,
        paidAt: verification.paidAt ?? new Date(),
        channel: verification.channel,
        gatewayReference: verification.gatewayReference ?? payment.gatewayReference,
        verificationPayload: verification.raw,
      },
      // A retry that succeeds must not keep the earlier failure reason.
      $unset: { failureReason: '' },
    },
  );

  recordActivity({
    action: 'payment.verified',
    telegramId: payment.telegramId,
    message: `${payment.gateway} confirmed ${verification.amountMinor} ${verification.currency}`,
    meta: { reference, trigger: options.trigger },
  });

  // Claim the right to fulfil. Exactly one caller wins; the rest back off.
  const staleBefore = new Date(Date.now() - FULFILMENT_LOCK_MS);
  const claimed = await Payment.findOneAndUpdate(
    {
      _id: payment._id,
      fulfilledAt: null,
      $or: [{ fulfilmentLock: null }, { fulfilmentLock: { $lte: staleBefore } }],
    },
    { $set: { fulfilmentLock: new Date() } },
    { returnDocument: 'after' },
  );

  if (!claimed) {
    const fresh = await Payment.findById(payment._id);
    if (fresh?.fulfilledAt) return { outcome: 'already_fulfilled', payment: fresh };
    log.warn('Fulfilment already in progress elsewhere', { reference });
    return { outcome: 'in_progress', payment: fresh ?? payment };
  }

  try {
    const result = await fulfilPayment(claimed);
    return { outcome: 'fulfilled', ...result };
  } catch (error) {
    // Release the lock so the reconciliation job can pick this up next run.
    await Payment.updateOne({ _id: payment._id }, { $set: { fulfilmentLock: null } });
    log.error('Fulfilment failed after a confirmed payment', { reference, error });
    throw error;
  }
}

/** Turns a verified payment into a subscription, an invite link and a DM. */
async function fulfilPayment(payment: IPayment): Promise<{
  payment: IPayment;
  subscription: ISubscription;
  inviteLink: IInviteLink | null;
  isRenewal: boolean;
}> {
  const { User } = await import('../models');
  const user = await User.findById(payment.user);
  if (!user) throw new Error(`Payment ${payment.reference} has no matching user record`);

  const plan = payment.plan ? await Plan.findById(payment.plan) : await Plan.findOne({ code: payment.planCode });

  const planSnapshot = plan
    ? snapshotFromPlan(plan)
    : {
        // The plan was deleted after checkout started; fall back to the
        // amount and name captured on the payment itself.
        code: payment.planCode,
        name: payment.planName,
        priceMinor: payment.amountMinor,
        currency: payment.currency,
        durationDays: 30,
      };

  const { subscription, isRenewal } = await activateOrExtend({
    user,
    planSnapshot,
    planId: plan ? (plan._id as Types.ObjectId) : undefined,
    paymentReference: payment.reference,
    source: 'payment',
  });

  let inviteLink: IInviteLink | null = null;
  try {
    inviteLink = await issueInviteLink({ user, subscription, payment });
  } catch (error) {
    // Access is already paid for; the subscriber can pull a link with /link.
    log.error('Could not issue an invite link', { reference: payment.reference, error });
  }

  payment.fulfilledAt = new Date();
  payment.fulfilmentLock = null as unknown as undefined;
  payment.subscription = subscription._id as Types.ObjectId;
  await payment.save();

  await notifyAccessGranted({
    telegramId: user.telegramId,
    subscription,
    inviteLink,
    isRenewal,
  });

  return { payment, subscription, inviteLink, isRenewal };
}

/**
 * How far back to look for a checkout a subscriber may have completed silently.
 *
 * Generous on purpose: a bank transfer can clear long after someone closes the
 * bot, and if the webhook is ever missed this is what rescues them. Twelve
 * hours once left a real payment unfulfilled because the subscriber next
 * opened the bot three days later.
 */
const PENDING_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Re-checks one subscriber's own recent payments, on demand.
 *
 * Called when someone opens /status or /link — precisely the moment a person
 * who paid but did not get in comes looking. It closes the gap between "the
 * webhook never arrived" and "the next scheduled pass", which matters a great
 * deal on a host whose scheduler only runs once a day.
 *
 * Cheap by construction: at most one gateway call for a recent unconfirmed
 * checkout, plus any payment already verified but not yet turned into access.
 */
export async function reconcileUserPayments(telegramId: number): Promise<FinalizeResult | null> {
  const unfulfilled = await Payment.findOne({ telegramId, status: 'success', fulfilledAt: null }).sort({
    createdAt: -1,
  });

  if (unfulfilled) {
    try {
      return await finalizePayment(unfulfilled.reference, { trigger: 'self-heal' });
    } catch (error) {
      log.error('On-demand reconciliation failed', { reference: unfulfilled.reference, error });
      return null;
    }
  }

  // `abandoned` is included: it only means we gave up waiting, not that the
  // money never arrived.
  const candidates = await Payment.find({
    telegramId,
    status: { $in: ['pending', 'abandoned'] },
    createdAt: { $gte: new Date(Date.now() - PENDING_LOOKBACK_MS) },
  })
    .sort({ createdAt: -1 })
    .limit(3);

  for (const candidate of candidates) {
    try {
      const result = await finalizePayment(candidate.reference, { trigger: 'self-heal' });
      if (result.outcome === 'fulfilled' || result.outcome === 'already_fulfilled') return result;
    } catch (error) {
      log.error('On-demand verification failed', { reference: candidate.reference, error });
    }
  }

  return null;
}

export interface PendingSweepReport {
  checked: number;
  rescued: number;
  abandoned: number;
}

/**
 * Re-asks the gateway about payments still waiting on an answer.
 *
 * This is the safety net for a webhook that never arrives — a misconfigured
 * webhook URL, a deploy during the callback, or a gateway outage. Without it a
 * real payment can sit unfulfilled indefinitely, which is exactly what happened
 * to a bank transfer whose webhook never reached us: Paystack said "success",
 * our record said "pending", and nothing ever asked again.
 */
export async function reconcilePendingPayments(
  options: { maxAgeMs?: number; limit?: number; minIntervalMs?: number } = {},
): Promise<PendingSweepReport> {
  const { maxAgeMs = PENDING_LOOKBACK_MS, limit = 20, minIntervalMs = 10 * 60 * 1000 } = options;
  const now = Date.now();

  const candidates = await Payment.find({
    status: 'pending',
    createdAt: { $gte: new Date(now - maxAgeMs) },
    $or: [{ lastVerifiedAt: null }, { lastVerifiedAt: { $lte: new Date(now - minIntervalMs) } }],
  })
    .sort({ createdAt: 1 })
    .limit(limit);

  const report: PendingSweepReport = { checked: 0, rescued: 0, abandoned: 0 };

  for (const payment of candidates) {
    report.checked += 1;
    try {
      const result = await finalizePayment(payment.reference, { trigger: 'pending-sweep' });
      if (result.outcome === 'fulfilled') {
        report.rescued += 1;
        log.warn('Rescued a paid-but-unfulfilled payment; the webhook did not arrive', {
          reference: payment.reference,
          telegramId: payment.telegramId,
        });
        await notifyAdmins(
          [
            '\u26A0\uFE0F <b>A payment was rescued, not delivered by webhook</b>',
            '',
            `Reference: <code>${payment.reference}</code>`,
            `Member: <code>${payment.telegramId}</code>`,
            '',
            'Access has been granted. Check that the Paystack webhook URL is set for the <b>live</b> keys:',
            '<code>/api/webhooks/paystack</code>',
          ].join('\n'),
        );
      } else if (result.outcome === 'failed') {
        report.abandoned += 1;
      }
    } catch (error) {
      log.error('Pending sweep failed for a payment', { reference: payment.reference, error });
    }
  }

  if (report.checked > 0) log.info('Pending payment sweep complete', report);
  return report;
}

/**
 * Safety net for the rare case where a payment was verified but fulfilment
 * crashed before the subscription existed. Runs on every scheduler pass.
 */
export async function reconcileUnfulfilledPayments(limit = 25): Promise<number> {
  const stuck = await Payment.find({ status: 'success', fulfilledAt: null })
    .sort({ createdAt: 1 })
    .limit(limit);

  let repaired = 0;
  for (const payment of stuck) {
    try {
      const result = await finalizePayment(payment.reference, { trigger: 'reconciliation' });
      if (result.outcome === 'fulfilled') repaired += 1;
    } catch (error) {
      log.error('Reconciliation failed', { reference: payment.reference, error });
    }
  }

  if (repaired > 0) log.info(`Reconciled ${repaired} unfulfilled payment(s)`);
  return repaired;
}
