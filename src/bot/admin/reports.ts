import { getEnv } from '../../config/env';
import { formatMoney } from '../../utils/money';
import { escapeHtml, displayName, truncate } from '../../utils/text';
import { formatDate, formatDay, humaniseRemaining } from '../../utils/time';
import { Payment, Subscription, User } from '../../models';
import { getSubscriptionStats } from '../../services/subscription.service';
import type { BotContext } from '../context';
import { adminBackKeyboard, memberActionsKeyboard, paginationKeyboard } from '../keyboards';
import { render } from '../helpers';
import { community } from '../texts';

const PAGE_SIZE = 8;

export async function showStats(ctx: BotContext): Promise<void> {
  const env = getEnv();
  const stats = await getSubscriptionStats();

  const [revenueAgg, paymentCounts, reachable] = await Promise.all([
    Payment.aggregate<{ _id: string; total: number; count: number }>([
      { $match: { status: 'success' } },
      { $group: { _id: '$gateway', total: { $sum: '$paidAmountMinor' }, count: { $sum: 1 } } },
    ]),
    Payment.aggregate<{ _id: string; count: number }>([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
    User.countDocuments({ hasBlockedBot: { $ne: true } }),
  ]);

  const totalRevenue = revenueAgg.reduce((sum, row) => sum + (row.total ?? 0), 0);
  const byStatus = Object.fromEntries(paymentCounts.map((row) => [row._id, row.count]));

  const lines = [
    '\u{1F4CA} <b>Overview</b>',
    '',
    '<b>Subscriptions</b>',
    `Active: <b>${stats.activeCount}</b>`,
    `Expiring within 7 days: <b>${stats.expiringIn7Days}</b>`,
    `Lapsed: <b>${stats.expiredCount}</b>`,
    `People who ever subscribed: <b>${stats.totalSubscribers}</b>`,
    '',
    '<b>Payments</b>',
    `Confirmed: <b>${byStatus.success ?? 0}</b>`,
    `Pending / abandoned: <b>${(byStatus.pending ?? 0) + (byStatus.abandoned ?? 0)}</b>`,
    `Failed: <b>${byStatus.failed ?? 0}</b>`,
    `Total collected: <b>${formatMoney(totalRevenue, env.CURRENCY)}</b>`,
  ];

  for (const row of revenueAgg) {
    lines.push(`  • ${escapeHtml(row._id)}: ${formatMoney(row.total ?? 0, env.CURRENCY)} (${row.count})`);
  }

  lines.push('', '<b>Bot</b>', `Reachable users: <b>${reachable}</b>`);

  await render(ctx, lines.join('\n'), adminBackKeyboard());
}

export async function showMembers(ctx: BotContext, page: number): Promise<void> {
  const total = await Subscription.countDocuments({ status: 'active' });
  const subscriptions = await Subscription.find({ status: 'active' })
    .sort({ expiresAt: 1 })
    .skip(page * PAGE_SIZE)
    .limit(PAGE_SIZE)
    .lean();

  if (subscriptions.length === 0) {
    await render(
      ctx,
      page === 0 ? '\u{1F465} <b>Members</b>\n\nNo active subscribers yet.' : '\u{1F465} No more members on this page.',
      adminBackKeyboard(),
    );
    return;
  }

  const ids = subscriptions.map((s) => s.telegramId);
  const users = await User.find({ telegramId: { $in: ids } }).lean();
  const userMap = new Map(users.map((u) => [u.telegramId, u]));

  const lines = [
    `\u{1F465} <b>Active members</b> — ${total} total`,
    `<i>Page ${page + 1} of ${Math.max(1, Math.ceil(total / PAGE_SIZE))}</i>`,
    '',
  ];

  for (const subscription of subscriptions) {
    const user = userMap.get(subscription.telegramId);
    const name = escapeHtml(
      displayName({
        firstName: user?.firstName,
        lastName: user?.lastName,
        username: user?.username,
        telegramId: subscription.telegramId,
      }),
    );
    lines.push(
      `<b>${name}</b>${user?.username ? ` (@${escapeHtml(user.username)})` : ''}`,
      `  id <code>${subscription.telegramId}</code> • ${escapeHtml(subscription.planSnapshot.name)}`,
      `  expires ${escapeHtml(formatDay(subscription.expiresAt))} — ${escapeHtml(humaniseRemaining(subscription.expiresAt))}`,
      '',
    );
  }

  lines.push('<i>Use /find &lt;name or id&gt; to act on one member.</i>');

  const hasNext = (page + 1) * PAGE_SIZE < total;
  await render(ctx, lines.join('\n'), paginationKeyboard('adm:members', page, hasNext));
}

export async function showPayments(ctx: BotContext, page: number): Promise<void> {
  const total = await Payment.countDocuments({});
  const payments = await Payment.find({})
    .sort({ createdAt: -1 })
    .skip(page * PAGE_SIZE)
    .limit(PAGE_SIZE)
    .lean();

  if (payments.length === 0) {
    await render(ctx, '\u{1F4B3} <b>Payments</b>\n\nNothing recorded yet.', adminBackKeyboard());
    return;
  }

  const icons: Record<string, string> = {
    success: '✅',
    pending: '⏳',
    failed: '❌',
    abandoned: '\u{1F6AB}',
  };

  const lines = [
    `\u{1F4B3} <b>Payments</b> — ${total} total`,
    `<i>Page ${page + 1} of ${Math.max(1, Math.ceil(total / PAGE_SIZE))}</i>`,
    '',
  ];

  for (const payment of payments) {
    lines.push(
      `${icons[payment.status] ?? '•'} <b>${formatMoney(payment.paidAmountMinor ?? payment.amountMinor, payment.currency)}</b> • ${escapeHtml(payment.gateway)}`,
      `  ${escapeHtml(payment.planName)} • id <code>${payment.telegramId}</code>`,
      `  <code>${escapeHtml(truncate(payment.reference, 40))}</code>`,
      `  ${escapeHtml(formatDate(payment.createdAt))}${payment.fulfilledAt ? ' • fulfilled' : ''}`,
      '',
    );
  }

  const hasNext = (page + 1) * PAGE_SIZE < total;
  await render(ctx, lines.join('\n'), paginationKeyboard('adm:payments', page, hasNext));
}

/** Full profile card for one subscriber, with the actions an admin can take. */
export async function showMemberCard(ctx: BotContext, telegramId: number): Promise<void> {
  const user = await User.findOne({ telegramId }).lean();
  if (!user) {
    await render(ctx, `⚠️ No record for <code>${telegramId}</code>.`, adminBackKeyboard());
    return;
  }

  const subscription = await Subscription.findOne({ telegramId }).sort({ createdAt: -1 }).lean();
  const payments = await Payment.find({ telegramId, status: 'success' }).sort({ createdAt: -1 }).limit(3).lean();
  const totalPaid = await Payment.aggregate<{ total: number }>([
    { $match: { telegramId, status: 'success' } },
    { $group: { _id: null, total: { $sum: '$paidAmountMinor' } } },
  ]);

  const isActive = Boolean(subscription && subscription.status === 'active' && subscription.expiresAt > new Date());

  const lines = [
    `\u{1F464} <b>${escapeHtml(displayName({ ...user, telegramId }))}</b>`,
    user.username ? `@${escapeHtml(user.username)}` : '',
    `Telegram id: <code>${telegramId}</code>`,
    user.email ? `Email: ${escapeHtml(user.email)}` : '',
    `In ${community()}: <b>${user.inGroup ? 'yes' : 'no'}</b>`,
    user.hasBlockedBot ? '⚠️ <i>Has blocked the bot</i>' : '',
    '',
  ].filter(Boolean);

  if (subscription) {
    lines.push(
      '<b>Subscription</b>',
      `Plan: ${escapeHtml(subscription.planSnapshot.name)}`,
      `Status: <b>${escapeHtml(subscription.status)}</b>`,
      `${isActive ? 'Expires' : 'Ended'}: ${escapeHtml(formatDate(subscription.expiresAt))}`,
      isActive ? `Time left: ${escapeHtml(humaniseRemaining(subscription.expiresAt))}` : '',
      `Renewals: ${subscription.renewalCount}`,
      '',
    );
  } else {
    lines.push('<b>Subscription</b>', '<i>Never subscribed</i>', '');
  }

  lines.push('<b>Payments</b>', `Total paid: <b>${formatMoney(totalPaid[0]?.total ?? 0, getEnv().CURRENCY)}</b>`);
  for (const payment of payments) {
    lines.push(
      `  • ${formatMoney(payment.paidAmountMinor ?? payment.amountMinor, payment.currency)} • ${escapeHtml(payment.gateway)} • ${escapeHtml(formatDay(payment.createdAt))}`,
    );
  }

  await render(ctx, lines.filter(Boolean).join('\n'), memberActionsKeyboard(telegramId, isActive));
}
