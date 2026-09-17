import { getEnv } from '../../config/env';
import { createLogger } from '../../utils/logger';
import { escapeHtml, truncate } from '../../utils/text';
import { recordActivity, type BroadcastAudience } from '../../models';
import { createBroadcast, resolveAudience } from '../../services/broadcast.service';
import { kickBroadcastWorker } from '../../services/dispatch';
import { copyMessageSafe, copyToGroup } from '../../services/telegram';
import { markUnreachable } from '../../services/user.service';
import type { BotContext } from '../context';
import { adminBackKeyboard, broadcastAudienceKeyboard, broadcastConfirmKeyboard, cancelKeyboard } from '../keyboards';
import { render, reply } from '../helpers';

const log = createLogger('admin:messaging');

const AUDIENCE_LABEL: Record<BroadcastAudience, string> = {
  all: 'every subscriber the bot can reach',
  active: 'members with an active subscription',
  expired: 'members whose subscription has lapsed',
};

export async function promptBroadcastAudience(ctx: BotContext): Promise<void> {
  ctx.session.step = undefined;
  await render(
    ctx,
    [
      '\u{1F4E3} <b>Broadcast</b>',
      '',
      'A broadcast is delivered privately to each member’s own chat with the bot, at a rate Telegram will not throttle.',
      '',
      'Who should receive it?',
    ].join('\n'),
    broadcastAudienceKeyboard(),
  );
}

export async function promptBroadcastMessage(ctx: BotContext, audience: BroadcastAudience): Promise<void> {
  const recipients = await resolveAudience(audience);

  ctx.session.step = 'adm_broadcast_message';
  ctx.session.admin = { ...ctx.session.admin, broadcastAudience: audience };

  await render(
    ctx,
    [
      `\u{1F4E3} <b>Broadcast to ${escapeHtml(AUDIENCE_LABEL[audience])}</b>`,
      '',
      `Recipients: <b>${recipients.length}</b>`,
      '',
      'Now send the message exactly as you want it delivered — text, a photo, a document, anything. Formatting and media are preserved.',
    ].join('\n'),
    cancelKeyboard(),
  );
}

/** Captures the admin's composed message and asks for confirmation. */
export async function captureBroadcastMessage(ctx: BotContext): Promise<boolean> {
  if (ctx.session.step !== 'adm_broadcast_message') return false;
  if (!ctx.message || !ctx.chat) return false;

  const audience = ctx.session.admin?.broadcastAudience ?? 'all';
  const preview = ctx.message.text ?? ctx.message.caption ?? `[${Object.keys(ctx.message).find((k) => ['photo', 'video', 'document', 'audio', 'voice', 'animation'].includes(k)) ?? 'media'}]`;

  ctx.session.step = 'adm_broadcast_confirm';
  ctx.session.admin = {
    ...ctx.session.admin,
    broadcastAudience: audience,
    broadcastMessage: { chatId: ctx.chat.id, messageId: ctx.message.message_id, preview },
  };

  const recipients = await resolveAudience(audience);

  await reply(
    ctx,
    [
      '\u{1F440} <b>Ready to send</b>',
      '',
      `Audience: <b>${escapeHtml(AUDIENCE_LABEL[audience])}</b>`,
      `Recipients: <b>${recipients.length}</b>`,
      `Preview: <i>${escapeHtml(truncate(preview, 120))}</i>`,
      '',
      'The message above is what each member will receive. Send it?',
    ].join('\n'),
    broadcastConfirmKeyboard(),
  );

  return true;
}

export async function sendBroadcast(ctx: BotContext): Promise<void> {
  const state = ctx.session.admin;
  const message = state?.broadcastMessage;
  const audience = state?.broadcastAudience ?? 'all';

  if (!message || !ctx.from) {
    await render(ctx, '⚠️ That broadcast draft has expired. Start again.', adminBackKeyboard());
    return;
  }

  const { total } = await createBroadcast({
    createdByTelegramId: ctx.from.id,
    audience,
    sourceChatId: message.chatId,
    sourceMessageId: message.messageId,
    preview: message.preview,
  });

  ctx.session.step = undefined;
  ctx.session.admin = {};

  await render(
    ctx,
    [
      '\u{1F680} <b>Broadcast queued</b>',
      '',
      `Queued for <b>${total}</b> recipient(s).`,
      '',
      'Messages are released at a safe rate. You will get a delivery summary here when it finishes.',
    ].join('\n'),
    adminBackKeyboard(),
  );

  // Awaited so the worker is genuinely running before this invocation ends.
  await kickBroadcastWorker();
}

export async function promptPostToGroup(ctx: BotContext): Promise<void> {
  ctx.session.step = 'adm_post';
  await render(
    ctx,
    [
      '\u{1F4E2} <b>Post to the group</b>',
      '',
      `Send the message you want posted in <b>${escapeHtml(getEnv().GROUP_NAME)}</b>.`,
      '',
      'Text, photos, charts and documents all work.',
    ].join('\n'),
    cancelKeyboard(),
  );
}

export async function handlePostStep(ctx: BotContext): Promise<boolean> {
  if (ctx.session.step !== 'adm_post') return false;
  if (!ctx.message || !ctx.chat) return false;

  ctx.session.step = undefined;

  const posted = await copyToGroup(ctx.chat.id, ctx.message.message_id);
  if (posted) {
    recordActivity({ action: 'admin.post', actorTelegramId: ctx.from?.id, message: 'Posted to the group' });
    await reply(ctx, '✅ Posted to the group.', adminBackKeyboard());
  } else {
    await reply(
      ctx,
      '⚠️ Could not post. Check that the bot is still an administrator in the group with permission to send messages.',
      adminBackKeyboard(),
    );
  }

  return true;
}

export async function promptDirectMessage(ctx: BotContext, telegramId: number): Promise<void> {
  ctx.session.step = 'adm_dm';
  ctx.session.admin = { ...ctx.session.admin, dmTargetTelegramId: telegramId };
  await render(
    ctx,
    `✉️ Send the message for <code>${telegramId}</code>. It will be delivered privately by the bot.`,
    cancelKeyboard(),
  );
}

export async function handleDirectMessageStep(ctx: BotContext): Promise<boolean> {
  if (ctx.session.step !== 'adm_dm') return false;
  if (!ctx.message || !ctx.chat) return false;

  const target = ctx.session.admin?.dmTargetTelegramId;
  ctx.session.step = undefined;

  if (!target) {
    await reply(ctx, '⚠️ Lost track of who that was for. Try /find again.');
    return true;
  }

  const outcome = await copyMessageSafe(target, ctx.chat.id, ctx.message.message_id);

  if (outcome.ok) {
    recordActivity({ action: 'admin.dm', telegramId: target, actorTelegramId: ctx.from?.id });
    await reply(ctx, `✅ Delivered to <code>${target}</code>.`, adminBackKeyboard());
  } else {
    if (outcome.unreachable) await markUnreachable(target);
    log.warn('Admin DM failed', { target, error: outcome.error });
    await reply(
      ctx,
      outcome.unreachable
        ? `⚠️ <code>${target}</code> has blocked the bot or never started a chat with it, so the message could not be delivered.`
        : `⚠️ Delivery failed: ${escapeHtml(outcome.error ?? 'unknown error')}`,
      adminBackKeyboard(),
    );
  }

  return true;
}
