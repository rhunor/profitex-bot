import { getEnv } from '../../config/env';
import { readSetting, writeSetting } from '../../models/AppSetting';
import { createLogger } from '../../utils/logger';
import { HOUR } from '../../utils/time';
import { checkTrialEligibility, grantTrial } from '../../services/trial.service';
import { notifyAdmins } from '../../services/notify.service';
import type { BotContext } from '../context';
import { joinGroupKeyboard, persistentMenu } from '../keyboards';
import * as texts from '../texts';
import { reply } from '../helpers';

const log = createLogger('bot:trial');
const LOOKUP_ALERT_KEY = 'trial_lookup_alert_at';

/**
 * Tells the admins, at most once an hour, that eligibility checks are failing.
 * Without this a broken setup fails quietly: every eligible member is simply
 * shown the paid plans instead of their free month.
 */
async function alertAdminsOfLookupFailure(reason: string): Promise<void> {
  const last = await readSetting(LOOKUP_ALERT_KEY);
  if (last && Date.now() - Number(last) < HOUR) return;
  await writeSetting(LOOKUP_ALERT_KEY, String(Date.now()));
  await notifyAdmins(
    [
      '⚠️ <b>Free-month checks are failing</b>',
      '',
      `Telegram said: <code>${reason.replace(/[<>&]/g, '')}</code>`,
      '',
      'Eligible members are being shown the paid plans instead. Open the setup link to see what is wrong.',
    ].join('\n'),
  );
}

/**
 * Checks whether this person qualifies for the free month and, if so, grants it
 * on the spot. Returns true when a grant was made — the caller should then
 * stop, because the person has just been given access.
 */
export async function offerTrialIfEligible(ctx: BotContext): Promise<boolean> {
  const env = getEnv();
  if (!env.trialEnabled || !ctx.user || ctx.user.trialClaimedAt) return false;

  // Telegram's full API takes a second or two; show that something is happening.
  await ctx.replyWithChatAction('typing').catch(() => undefined);

  const eligibility = await checkTrialEligibility(ctx.user);

  if (eligibility.verdict === 'lookup_failed') {
    await alertAdminsOfLookupFailure(eligibility.reason ?? 'unknown error').catch(() => undefined);
    return false;
  }
  if (eligibility.verdict !== 'eligible') return false;

  const grant = await grantTrial(ctx.user, eligibility.joinedAt);
  if (!grant) return false; // claimed a moment ago on another device

  log.info('Free month granted', { telegramId: ctx.user.telegramId, extended: grant.extendedExisting });

  if (grant.extendedExisting) {
    await reply(ctx, texts.trialAddedToExisting(grant.subscription.expiresAt, env.TRIAL_DAYS));
    return true;
  }

  await ctx.reply(
    texts.trialGranted({
      days: env.TRIAL_DAYS,
      linkTtlMinutes: env.INVITE_LINK_TTL_MINUTES,
      hasLink: Boolean(grant.inviteLink),
    }),
    {
      parse_mode: 'HTML',
      reply_markup: grant.inviteLink ? joinGroupKeyboard(grant.inviteLink.inviteLink) : persistentMenu(),
      link_preview_options: { is_disabled: true },
    },
  );
  return true;
}
