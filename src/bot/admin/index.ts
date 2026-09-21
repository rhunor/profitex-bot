import { Composer } from 'grammy';
import { createLogger } from '../../utils/logger';
import { escapeHtml } from '../../utils/text';
import type { BroadcastAudience } from '../../models';
import { runScheduledWork } from '../../jobs/scheduler';
import { requireAdmin } from '../middlewares';
import type { BotContext } from '../context';
import { adminBackKeyboard, adminMenuKeyboard } from '../keyboards';
import { community } from '../texts';
import { clearStep, render, reply, toast } from '../helpers';
import { showMemberCard, showMembers, showPayments, showStats } from './reports';
import {
  handlePlanStep,
  promptPlanAdd,
  promptPlanField,
  showPlanAdmin,
  showPlanEditor,
  toggleBadge,
  togglePlan,
} from './plans';
import {
  captureBroadcastMessage,
  handleDirectMessageStep,
  handlePostStep,
  promptBroadcastAudience,
  promptBroadcastMessage,
  promptDirectMessage,
  promptPostBody,
  promptPostToGroup,
  sendBroadcast,
} from './messaging';
import { handleGrantStep, promptFindMember, promptGrant, revokeAccess, runMemberSearch } from './access';

const log = createLogger('bot:admin');

export const adminHandlers = new Composer<BotContext>();

// Everything registered on this composer is admin-only.
const admin = adminHandlers.filter((ctx) => Boolean(ctx.isAdmin));

async function showAdminMenu(ctx: BotContext): Promise<void> {
  clearStep(ctx);
  await render(
    ctx,
    [
      '\u{1F6E0}️ <b>Admin</b>',
      '',
      'Everything you need to run the academy from inside Telegram.',
      '',
      '<b>Shortcuts</b>',
      '/members — active subscribers',
      '/find &lt;name or id&gt; — look someone up',
      '/grant &lt;id&gt; &lt;plan|days&gt; — give or extend access',
      '/revoke &lt;id&gt; — end access now',
      '/dm &lt;id&gt; &lt;message&gt; — message one person',
      `/post &lt;message&gt; — post in the ${community()}`,
      '/broadcast — message many members',
      '/cron — run the expiry pass now',
    ].join('\n'),
    adminMenuKeyboard(),
  );
}

/* ── Commands ─────────────────────────────────────────────────── */

adminHandlers.command('admin', requireAdmin, async (ctx) => {
  await showAdminMenu(ctx);
});

admin.command('stats', async (ctx) => {
  clearStep(ctx);
  await showStats(ctx);
});

admin.command('members', async (ctx) => {
  clearStep(ctx);
  await showMembers(ctx, 0);
});

admin.command('payments', async (ctx) => {
  clearStep(ctx);
  await showPayments(ctx, 0);
});

admin.command('plans_admin', async (ctx) => {
  clearStep(ctx);
  await showPlanAdmin(ctx);
});

admin.command('find', async (ctx) => {
  clearStep(ctx);
  const query = ctx.match?.toString().trim();
  if (!query) {
    await promptFindMember(ctx);
    return;
  }
  await runMemberSearch(ctx, query);
});

admin.command('grant', async (ctx) => {
  clearStep(ctx);
  const [idRaw, ...rest] = (ctx.match?.toString() ?? '').trim().split(/\s+/).filter(Boolean);
  const telegramId = Number(idRaw);

  if (!Number.isInteger(telegramId)) {
    await reply(ctx, 'Usage: <code>/grant &lt;telegram id&gt; &lt;plan code or days&gt;</code>');
    return;
  }

  if (rest.length === 0) {
    await promptGrant(ctx, telegramId);
    return;
  }

  // Re-enter the grant step with the argument already supplied.
  ctx.session.step = 'adm_grant';
  ctx.session.admin = { ...ctx.session.admin, grantTargetTelegramId: telegramId };
  if (ctx.message) ctx.message.text = rest.join(' ');
  await handleGrantStep(ctx);
});

admin.command('revoke', async (ctx) => {
  clearStep(ctx);
  const telegramId = Number((ctx.match?.toString() ?? '').trim());
  if (!Number.isInteger(telegramId)) {
    await reply(ctx, 'Usage: <code>/revoke &lt;telegram id&gt;</code>');
    return;
  }
  await revokeAccess(ctx, telegramId);
});

admin.command('dm', async (ctx) => {
  clearStep(ctx);
  const raw = (ctx.match?.toString() ?? '').trim();
  const [idRaw, ...rest] = raw.split(/\s+/).filter(Boolean);
  const telegramId = Number(idRaw);

  if (!Number.isInteger(telegramId)) {
    await reply(ctx, 'Usage: <code>/dm &lt;telegram id&gt; &lt;message&gt;</code>');
    return;
  }

  if (rest.length === 0) {
    await promptDirectMessage(ctx, telegramId);
    return;
  }

  const { sendMessageSafe } = await import('../../services/telegram');
  const outcome = await sendMessageSafe(telegramId, escapeHtml(rest.join(' ')));
  await reply(
    ctx,
    outcome.ok
      ? `✅ Delivered to <code>${telegramId}</code>.`
      : `⚠️ Could not deliver${outcome.unreachable ? ' — they have blocked the bot or never started a chat' : ''}.`,
  );
});

admin.command('post', async (ctx) => {
  clearStep(ctx);
  const text = (ctx.match?.toString() ?? '').trim();
  const replied = ctx.message?.reply_to_message;

  if (!text && !replied) {
    await promptPostToGroup(ctx);
    return;
  }

  const { copyToChat, sendMessageSafe } = await import('../../services/telegram');
  const { getEnv } = await import('../../config/env');

  // A direct /post goes to the paid community; use the menu to choose another.
  const target = getEnv().GROUP_CHAT_ID;
  const posted = replied
    ? (await copyToChat(target, ctx.chat!.id, replied.message_id)).ok
    : (await sendMessageSafe(target, escapeHtml(text))).ok;

  await reply(
    ctx,
    posted
      ? `✅ Posted to the ${community()} (<code>${target}</code>).`
      : `⚠️ Could not post to the ${community()} (<code>${target}</code>). Use /admin → Post to see every chat I can post in.`,
  );
});

admin.command('broadcast', async (ctx) => {
  clearStep(ctx);
  await promptBroadcastAudience(ctx);
});

admin.command('cron', async (ctx) => {
  await reply(ctx, '⏳ Running the maintenance pass…');
  const report = await runScheduledWork({ broadcastBudgetMs: 10_000 });
  await reply(
    ctx,
    [
      '✅ <b>Maintenance pass complete</b>',
      '',
      `Duration: ${report.durationMs} ms`,
      `Reminders sent: <b>${report.reminders.sent}</b> (7d ${report.reminders.byKey.d7}, 3d ${report.reminders.byKey.d3}, 24h ${report.reminders.byKey.h24})`,
      `Expired &amp; removed: <b>${report.expiry.removed}</b> of ${report.expiry.due} due`,
      `Payments reconciled: <b>${report.reconciledPayments}</b>`,
      `Broadcast messages sent: <b>${report.broadcast.sent}</b>`,
      report.errors.length ? `⚠️ Errors: ${escapeHtml(report.errors.join('; '))}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
    adminBackKeyboard(),
  );
});

/* ── Callback routes ──────────────────────────────────────────── */

admin.callbackQuery('adm:menu', async (ctx) => {
  await showAdminMenu(ctx);
});

admin.callbackQuery('adm:cancel', async (ctx) => {
  clearStep(ctx);
  await toast(ctx, 'Cancelled.');
  await showAdminMenu(ctx);
});

admin.callbackQuery('adm:stats', async (ctx) => {
  await showStats(ctx);
});

admin.callbackQuery(/^adm:members:(\d+)$/, async (ctx) => {
  await showMembers(ctx, Number(ctx.match[1]));
});

admin.callbackQuery(/^adm:payments:(\d+)$/, async (ctx) => {
  await showPayments(ctx, Number(ctx.match[1]));
});

admin.callbackQuery('adm:find', async (ctx) => {
  await promptFindMember(ctx);
});

admin.callbackQuery(/^adm:user:(\d+)$/, async (ctx) => {
  await showMemberCard(ctx, Number(ctx.match[1]));
});

admin.callbackQuery(/^adm:dm:(\d+)$/, async (ctx) => {
  await promptDirectMessage(ctx, Number(ctx.match[1]));
});

admin.callbackQuery(/^adm:grant:(\d+)$/, async (ctx) => {
  await promptGrant(ctx, Number(ctx.match[1]));
});

admin.callbackQuery(/^adm:revoke:(\d+)$/, async (ctx) => {
  await revokeAccess(ctx, Number(ctx.match[1]));
});

admin.callbackQuery('adm:plans', async (ctx) => {
  await showPlanAdmin(ctx);
});

admin.callbackQuery('adm:planadd', async (ctx) => {
  await promptPlanAdd(ctx);
});

admin.callbackQuery(/^adm:plan:([a-f0-9]{24})$/i, async (ctx) => {
  await showPlanEditor(ctx, ctx.match[1]);
});

admin.callbackQuery(/^adm:planbadge:([a-f0-9]{24})$/i, async (ctx) => {
  await toggleBadge(ctx, ctx.match[1]);
});

admin.callbackQuery(/^adm:plantoggle:([a-f0-9]{24})$/i, async (ctx) => {
  await togglePlan(ctx, ctx.match[1]);
});

admin.callbackQuery(/^adm:planprice:([a-f0-9]{24})$/i, async (ctx) => {
  await promptPlanField(ctx, ctx.match[1], 'price');
});

admin.callbackQuery(/^adm:planname:([a-f0-9]{24})$/i, async (ctx) => {
  await promptPlanField(ctx, ctx.match[1], 'name');
});

admin.callbackQuery(/^adm:plandays:([a-f0-9]{24})$/i, async (ctx) => {
  await promptPlanField(ctx, ctx.match[1], 'days');
});

admin.callbackQuery('adm:post', async (ctx) => {
  await promptPostToGroup(ctx);
});

admin.callbackQuery(/^adm:postto:(-?\d+)$/, async (ctx) => {
  await promptPostBody(ctx, Number(ctx.match[1]));
});

admin.callbackQuery('adm:bc', async (ctx) => {
  await promptBroadcastAudience(ctx);
});

admin.callbackQuery(/^adm:bc:(all|active|expired)$/, async (ctx) => {
  await promptBroadcastMessage(ctx, ctx.match[1] as BroadcastAudience);
});

admin.callbackQuery('adm:bc:send', async (ctx) => {
  await sendBroadcast(ctx);
});

admin.callbackQuery('adm:bc:cancel', async (ctx) => {
  clearStep(ctx);
  await toast(ctx, 'Broadcast cancelled.');
  await showAdminMenu(ctx);
});

/**
 * Dispatches a plain text/media message to whichever admin flow is in progress.
 * Returns true when the message was consumed.
 */
export async function handleAdminStep(ctx: BotContext): Promise<boolean> {
  if (!ctx.isAdmin) return false;
  const step = ctx.session.step;
  if (!step || !step.startsWith('adm_')) return false;

  try {
    if (step === 'adm_find') {
      ctx.session.step = undefined;
      await runMemberSearch(ctx, ctx.message?.text ?? '');
      return true;
    }
    if (step === 'adm_grant') return await handleGrantStep(ctx);
    if (step === 'adm_dm') return await handleDirectMessageStep(ctx);
    if (step === 'adm_post') return await handlePostStep(ctx);
    if (step === 'adm_broadcast_message') return await captureBroadcastMessage(ctx);
    if (step.startsWith('adm_plan')) return await handlePlanStep(ctx);
  } catch (error) {
    log.error(`Admin step "${step}" failed`, error);
    clearStep(ctx);
    await reply(ctx, '⚠️ That did not work. Start again from /admin.');
    return true;
  }

  return false;
}
