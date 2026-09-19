import { getEnv } from '../config/env';
import { createLogger } from '../utils/logger';
import { addDays, MINUTE } from '../utils/time';
import { Subscription, User, recordActivity, type ISubscription, type IUser } from '../models';
import { activateOrExtend, getActiveSubscription } from './subscription.service';
import { issueInviteLink } from './invite.service';
import { lookupMembership, type Membership } from './mtproto';
import type { IInviteLink } from '../models';

const log = createLogger('trial');

/**
 * Why a person does or does not get the free month.
 * Only `eligible` leads to a grant; the rest route them to the normal plans.
 */
export type TrialVerdict =
  | 'eligible'
  | 'disabled'
  | 'already_claimed'
  | 'not_member'
  | 'joined_too_early'
  | 'lookup_failed';

export interface EligibilityResult {
  verdict: TrialVerdict;
  joinedAt?: Date | null;
  reason?: string;
}

/**
 * Negative answers are cached so a non-eligible person pressing /start does not
 * query Telegram every time. Short enough that someone who joins the source
 * channel a moment later is recognised almost straight away.
 */
const NEGATIVE_CACHE_MS = 15 * MINUTE;

/** Swappable for tests; production always asks Telegram. */
let membershipLookup: (chatId: number, userId: number) => Promise<Membership> = lookupMembership;
export function setMembershipLookupForTests(fn: typeof membershipLookup): void {
  membershipLookup = fn;
}

export async function checkTrialEligibility(user: IUser, now: Date = new Date()): Promise<EligibilityResult> {
  const env = getEnv();
  if (!env.trialEnabled || !env.TRIAL_SOURCE_CHAT_ID || !env.trialEligibleFrom) return { verdict: 'disabled' };
  if (user.trialClaimedAt) return { verdict: 'already_claimed' };

  const cached = user.trialCheck;
  if (
    cached?.checkedAt &&
    cached.result !== 'eligible' &&
    now.getTime() - new Date(cached.checkedAt).getTime() < NEGATIVE_CACHE_MS
  ) {
    return { verdict: cached.result as TrialVerdict, joinedAt: cached.joinedAt };
  }

  const membership = await membershipLookup(env.TRIAL_SOURCE_CHAT_ID, user.telegramId);

  let result: EligibilityResult;
  if (membership.status === 'error') {
    result = { verdict: 'lookup_failed', reason: membership.reason };
  } else if (membership.status === 'not_member') {
    result = { verdict: 'not_member' };
  } else if (!membership.joinedAt) {
    // The creator: no join date exists. Staff, not a subscriber.
    result = { verdict: 'joined_too_early', joinedAt: null };
  } else if (membership.joinedAt >= env.trialEligibleFrom) {
    result = { verdict: 'eligible', joinedAt: membership.joinedAt };
  } else {
    result = { verdict: 'joined_too_early', joinedAt: membership.joinedAt };
  }

  // A failed lookup is not cached: it says nothing about the person.
  if (result.verdict !== 'lookup_failed') {
    await User.updateOne(
      { _id: user._id },
      { $set: { trialCheck: { result: result.verdict, joinedAt: result.joinedAt ?? undefined, checkedAt: now } } },
    );
  }

  return result;
}

export interface TrialGrant {
  subscription: ISubscription;
  inviteLink: IInviteLink | null;
  /** True when the free month was added to access they already had. */
  extendedExisting: boolean;
}

/**
 * Grants the free month exactly once per person.
 *
 * The claim is taken atomically on the user record before anything else, so two
 * quick taps (or two devices) can never produce two free months.
 */
export async function grantTrial(user: IUser, joinedSourceAt: Date | null | undefined): Promise<TrialGrant | null> {
  const env = getEnv();

  const claimed = await User.findOneAndUpdate(
    { _id: user._id, trialClaimedAt: null },
    { $set: { trialClaimedAt: new Date() } },
    { returnDocument: 'after' },
  );
  if (!claimed) return null;

  const existing = await getActiveSubscription(user.telegramId);
  const hasLiveAccess = Boolean(existing && existing.expiresAt > new Date());

  try {
    const { subscription } = await activateOrExtend({
      user: claimed,
      planSnapshot: {
        code: 'free-trial',
        name: `Free ${env.TRIAL_DAYS}-day access`,
        priceMinor: 0,
        currency: env.CURRENCY,
        durationDays: env.TRIAL_DAYS,
      },
      // Someone already paying keeps their paid record; the month is added on top.
      source: hasLiveAccess ? existing!.source : 'trial',
      notes: `Free month: joined the source community ${joinedSourceAt ? joinedSourceAt.toISOString() : 'unknown'}`,
    });

    recordActivity({
      action: 'trial.granted',
      telegramId: user.telegramId,
      message: hasLiveAccess ? 'Free month added to existing access' : 'Free month started',
      meta: { joinedSourceAt, expiresAt: subscription.expiresAt },
    });

    let inviteLink: IInviteLink | null = null;
    try {
      inviteLink = await issueInviteLink({ user: claimed, subscription });
    } catch (error) {
      log.error('Could not issue an invite link for a free month', error);
    }

    return { subscription, inviteLink, extendedExisting: hasLiveAccess };
  } catch (error) {
    // Nothing was granted, so give the claim back rather than burn it.
    await User.updateOne({ _id: user._id }, { $set: { trialClaimedAt: null } });
    throw error;
  }
}

/**
 * The free month counts from when the person actually joins the paid channel,
 * not from when they claimed it — someone who claims on Monday and joins on
 * Thursday still gets their full month. Runs once, on the first join.
 */
export async function startTrialClockOnJoin(telegramId: number, joinedAt: Date): Promise<ISubscription | null> {
  const env = getEnv();

  const subscription = await Subscription.findOneAndUpdate(
    { telegramId, status: 'active', source: 'trial', trialClockStartedAt: { $exists: false } },
    {
      $set: {
        startsAt: joinedAt,
        expiresAt: addDays(joinedAt, env.TRIAL_DAYS),
        cycleStartedAt: joinedAt,
        trialClockStartedAt: joinedAt,
        remindersSent: {},
      },
    },
    { returnDocument: 'after' },
  );

  if (subscription) {
    recordActivity({
      action: 'trial.clock_started',
      telegramId,
      message: `Free month runs until ${subscription.expiresAt.toISOString()}`,
    });
    log.info('Free-month clock started on join', { telegramId, expiresAt: subscription.expiresAt });
  }
  return subscription;
}

export function isTrial(subscription: Pick<ISubscription, 'source'> | null | undefined): boolean {
  return subscription?.source === 'trial';
}

