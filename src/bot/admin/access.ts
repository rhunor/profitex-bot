import { escapeHtml, displayName } from '../../utils/text';
import { formatDate } from '../../utils/time';
import { InlineKeyboard } from 'grammy';
import { Plan, recordActivity } from '../../models';
import { findUserByTelegramId, searchUsers, setGroupMembership } from '../../services/user.service';
import {
  activateOrExtend,
  getActiveSubscription,
  revokeSubscription,
  snapshotFromPlan,
} from '../../services/subscription.service';
import { issueInviteLink, revokeActiveLinksFor } from '../../services/invite.service';
import { removeMemberFromGroup, sendMessageSafe } from '../../services/telegram';
import { notifyAccessGranted } from '../../services/notify.service';
import type { BotContext } from '../context';
import { adminBackKeyboard, cancelKeyboard } from '../keyboards';
import { render, reply } from '../helpers';
import { community } from '../texts';
import { showMemberCard } from './reports';

export async function promptFindMember(ctx: BotContext): Promise<void> {
  ctx.session.step = 'adm_find';
  await render(
    ctx,
    '\u{1F50D} Send a Telegram id, a @username, or part of a name.',
    cancelKeyboard(),
  );
}

export async function runMemberSearch(ctx: BotContext, query: string): Promise<void> {
  const matches = await searchUsers(query, 10);

  if (matches.length === 0) {
    await reply(ctx, `\u{1F50D} Nothing matched <b>${escapeHtml(query)}</b>.`, adminBackKeyboard());
    return;
  }

  if (matches.length === 1) {
    await showMemberCard(ctx, matches[0].telegramId);
    return;
  }

  const keyboard = new InlineKeyboard();
  for (const user of matches) {
    keyboard
      .text(
        `${displayName({ ...user.toObject(), telegramId: user.telegramId })}${user.username ? ` (@${user.username})` : ''}`,
        `adm:user:${user.telegramId}`,
      )
      .row();
  }
  keyboard.text('⬅️ Admin menu', 'adm:menu');

  await reply(ctx, `\u{1F50D} <b>${matches.length} matches</b> — pick one:`, keyboard);
}

export async function promptGrant(ctx: BotContext, telegramId: number): Promise<void> {
  const plans = await Plan.find({ isActive: true }).sort({ sortOrder: 1 }).lean();
  ctx.session.step = 'adm_grant';
  ctx.session.admin = { ...ctx.session.admin, grantTargetTelegramId: telegramId };

  const planList = plans.map((p) => `<code>${escapeHtml(p.code)}</code> — ${escapeHtml(p.name)}`).join('\n');

  await render(
    ctx,
    [
      `\u{1F381} <b>Grant or extend access for <code>${telegramId}</code></b>`,
      '',
      'Reply with a plan code:',
      planList || '<i>no active plans</i>',
      '',
      'Or reply with a number of days, for example <code>14</code>.',
      '',
      '<i>Time is added on top of any access they already have.</i>',
    ].join('\n'),
    cancelKeyboard(),
  );
}

/** Text step: an admin is replying with a plan code or a day count. */
export async function handleGrantStep(ctx: BotContext): Promise<boolean> {
  if (ctx.session.step !== 'adm_grant') return false;

  const input = (ctx.message?.text ?? '').trim();
  const telegramId = ctx.session.admin?.grantTargetTelegramId;

  if (!telegramId) {
    ctx.session.step = undefined;
    await reply(ctx, '⚠️ Lost track of who that was for. Try /find again.');
    return true;
  }

  const user = await findUserByTelegramId(telegramId);
  if (!user) {
    ctx.session.step = undefined;
    await reply(ctx, `⚠️ No record for <code>${telegramId}</code>.`);
    return true;
  }

  const days = Number(input.replace(/d(ays?)?$/i, '').trim());
  const plan = await Plan.findOne({ code: input.toLowerCase() });

  if (!plan && (!Number.isInteger(days) || days < 1 || days > 3650)) {
    await reply(ctx, '⚠️ Send a valid plan code, or a whole number of days between 1 and 3650.');
    return true;
  }

  ctx.session.step = undefined;

  const planSnapshot = plan
    ? snapshotFromPlan(plan)
    : {
        code: 'manual',
        name: `Manual grant (${days} days)`,
        priceMinor: 0,
        currency: 'NGN',
        durationDays: days,
      };

  const { subscription, isRenewal } = await activateOrExtend({
    user,
    planSnapshot,
    planId: plan ? (plan._id as never) : undefined,
    durationDays: plan ? plan.durationDays : days,
    source: 'manual',
    notes: `Granted by admin ${ctx.from?.id}`,
  });

  recordActivity({
    action: 'subscription.granted',
    telegramId,
    actorTelegramId: ctx.from?.id,
    message: `${planSnapshot.name} until ${subscription.expiresAt.toISOString()}`,
  });

  let inviteLink = null;
  try {
    inviteLink = await issueInviteLink({ user, subscription });
  } catch {
    /* the subscriber can still pull one with /link */
  }

  await notifyAccessGranted({ telegramId, subscription, inviteLink, isRenewal });

  await reply(
    ctx,
    [
      '✅ <b>Access granted</b>',
      '',
      `Member: <code>${telegramId}</code>`,
      `Plan: ${escapeHtml(planSnapshot.name)}`,
      `Now active until: <b>${escapeHtml(formatDate(subscription.expiresAt))}</b>`,
      inviteLink ? 'An invite link has been sent to them.' : '⚠️ Could not issue an invite link — ask them to tap /link.',
    ].join('\n'),
    adminBackKeyboard(),
  );

  return true;
}

export async function revokeAccess(ctx: BotContext, telegramId: number): Promise<void> {
  const subscription = await getActiveSubscription(telegramId);

  const removal = await removeMemberFromGroup(telegramId);
  await revokeActiveLinksFor(telegramId);
  if (removal.ok) await setGroupMembership(telegramId, false);

  if (subscription) {
    await revokeSubscription(subscription, ctx.from?.id, `Revoked by admin ${ctx.from?.id}`);
  }

  await sendMessageSafe(
    telegramId,
    [
      '⚠️ <b>Your access has been revoked</b>',
      '',
      `An administrator has ended your access to the ${community()}. If you think this is a mistake, please reply here.`,
    ].join('\n'),
  );

  await render(
    ctx,
    [
      '\u{1F6AB} <b>Access revoked</b>',
      '',
      `Member: <code>${telegramId}</code>`,
      removal.ok ? `Removed from the ${community()}.` : `⚠️ Removal failed: ${escapeHtml(removal.error ?? '')}`,
      subscription ? 'Subscription marked as revoked.' : 'No active subscription was on record.',
    ].join('\n'),
    adminBackKeyboard(),
  );
}
