import { getEnv } from '../config/env';
import { formatMoney } from '../utils/money';
import { escapeHtml } from '../utils/text';
import { formatDate, humaniseRemaining } from '../utils/time';
import type { IPlan, ISubscription } from '../models';

/** "channel" or "group", matching COMMUNITY_TYPE. */
export function community(): string {
  return getEnv().COMMUNITY_TYPE;
}

/* All copy lives here so wording can be changed without touching flow logic.
   Everything is written for Telegram's HTML parse mode. */

export function planDuration(days: number): string {
  if (days % 365 === 0) {
    const years = days / 365;
    return years === 1 ? '1 year' : `${years} years`;
  }
  if (days % 30 === 0) {
    const months = days / 30;
    return months === 1 ? '1 month' : `${months} months`;
  }
  if (days % 7 === 0) {
    const weeks = days / 7;
    return weeks === 1 ? '1 week' : `${weeks} weeks`;
  }
  return `${days} day${days === 1 ? '' : 's'}`;
}

export function planLabel(plan: IPlan): string {
  return `${plan.name} — ${formatMoney(plan.priceMinor, plan.currency)}`;
}

export function welcome(firstName?: string): string {
  const env = getEnv();
  const name = firstName ? escapeHtml(firstName) : 'there';
  return [
    `\u{1F44B} <b>Welcome, ${name}!</b>`,
    '',
    `This is the official bot for <b>${escapeHtml(env.GROUP_NAME)}</b>.`,
    '',
    'Here you can:',
    '• Choose a subscription plan and pay securely',
    '• Get your own private, single-use invite link',
    '• Check when your access expires and renew in two taps',
    '',
    'Tap <b>View Plans</b> below to get started.',
  ].join('\n');
}

export function mainMenuHint(): string {
  return 'What would you like to do?';
}

export function planList(): string {
  const env = getEnv();
  return [
    `\u{1F4E6} <b>Subscription plans</b>`,
    '',
    `Pick how long you want access to <b>${escapeHtml(env.GROUP_NAME)}</b>.`,
  ].join('\n');
}

export function planDetail(plan: IPlan): string {
  const lines = [
    `\u{1F4E6} <b>${escapeHtml(plan.name)}</b>${plan.badge ? ` \u2014 \u2B50 <b>${escapeHtml(plan.badge)}</b>` : ''}`,
    '',
    `Price: <b>${formatMoney(plan.priceMinor, plan.currency)}</b>`,
    `Duration: <b>${planDuration(plan.durationDays)}</b>`,
  ];
  if (plan.description) {
    lines.push('', escapeHtml(plan.description));
  }
  lines.push('', 'Choose how you would like to pay.');
  return lines.join('\n');
}

export function askEmail(): string {
  return [
    '\u{1F4E7} <b>One quick thing</b>',
    '',
    'Send me the email address your payment receipt should go to.',
    '',
    '<i>Payment gateways require it. We only use it for receipts.</i>',
  ].join('\n');
}

export function invalidEmail(): string {
  return '⚠️ That does not look like a valid email address. Please try again, for example <code>you@example.com</code>.';
}

export function checkoutReady(planName: string, amountMinor: number, currency: string, gatewayLabel: string): string {
  return [
    `\u{1F4B3} <b>Checkout ready</b>`,
    '',
    `Plan: <b>${escapeHtml(planName)}</b>`,
    `Amount: <b>${formatMoney(amountMinor, currency)}</b>`,
    `Gateway: <b>${escapeHtml(gatewayLabel)}</b>`,
    '',
    'Tap <b>Pay Now</b> to open the secure checkout page. Once you have paid, come back here and tap <b>I have paid</b>.',
    '',
    '<i>Your access is granted automatically the moment the payment is confirmed — usually within seconds.</i>',
  ].join('\n');
}

export function paymentPending(): string {
  const env = getEnv();
  return [
    '\u23F3 <b>Payment not completed yet</b>',
    '',
    'We have not received confirmation for this order.',
    'If you have just paid by transfer or USSD, it can take a few minutes.',
    '',
    '<b>You do not need to keep checking.</b> The moment it clears, this bot sends you your invite link automatically.',
    '',
    'If you have not actually paid yet, tap <b>Pay Now</b> to finish.',
    env.SUPPORT_USERNAME
      ? `If money left your account more than 10 minutes ago, send your reference below to @${escapeHtml(env.SUPPORT_USERNAME)}.`
      : 'If money left your account more than 10 minutes ago, contact support with your reference below.',
  ].join('\n');
}

export function paymentFailed(reason?: string): string {
  return [
    '❌ <b>Payment was not successful</b>',
    '',
    reason ? `Reason: <i>${escapeHtml(reason)}</i>` : 'The gateway reported that this payment did not go through.',
    '',
    'No access has been granted and you have not been charged for it. You can start a new payment at any time.',
  ].join('\n');
}

export function accessGranted(params: {
  planName: string;
  expiresAt: Date;
  isRenewal: boolean;
  linkTtlMinutes: number;
}): string {
  const env = getEnv();
  return [
    params.isRenewal ? '✅ <b>Renewal confirmed!</b>' : '\u{1F389} <b>Payment confirmed!</b>',
    '',
    `Plan: <b>${escapeHtml(params.planName)}</b>`,
    `Access until: <b>${escapeHtml(formatDate(params.expiresAt))}</b>`,
    '',
    params.isRenewal
      ? `Your existing access has been extended — you keep every day you already had.`
      : `Tap the button below to join <b>${escapeHtml(env.GROUP_NAME)}</b>.`,
    '',
    params.isRenewal
      ? ''
      : `⚠️ This link works <b>once</b> and expires in <b>${params.linkTtlMinutes} minutes</b>. Do not share it — if someone else uses it, you will not be able to join.`,
  ]
    .filter((line) => line !== '')
    .join('\n');
}

export function inviteLinkMessage(expiresAt: Date): string {
  const env = getEnv();
  return [
    `\u{1F517} <b>Your private invite link</b>`,
    '',
    `It admits <b>one person</b> and expires <b>${escapeHtml(formatDate(expiresAt))}</b>.`,
    '',
    `Tap the button to join <b>${escapeHtml(env.GROUP_NAME)}</b>.`,
  ].join('\n');
}

export function noActiveSubscription(): string {
  return [
    '\u{1F6AB} <b>No active subscription</b>',
    '',
    'You do not have access right now. Choose a plan to get started.',
  ].join('\n');
}

export function subscriptionStatus(subscription: ISubscription): string {
  const active = subscription.status === 'active' && subscription.expiresAt > new Date();
  const lines = [
    active ? '✅ <b>Your subscription is active</b>' : '⚠️ <b>Your subscription is not active</b>',
    '',
    `Plan: <b>${escapeHtml(subscription.planSnapshot.name)}</b>`,
    `Status: <b>${escapeHtml(subscription.status)}</b>`,
    `${active ? 'Expires' : 'Expired'}: <b>${escapeHtml(formatDate(subscription.expiresAt))}</b>`,
  ];
  if (active) {
    lines.push(`Time left: <b>${escapeHtml(humaniseRemaining(subscription.expiresAt))}</b>`);
  }
  if (subscription.renewalCount > 0) {
    lines.push(`Renewals: <b>${subscription.renewalCount}</b>`);
  }
  return lines.join('\n');
}

const onTrial = (s: ISubscription) => s.source === 'trial';

export function reminder7Day(subscription: ISubscription): string {
  const env = getEnv();
  if (onTrial(subscription)) {
    return [
      '\u{1F514} <b>Your free month ends in 7 days</b>',
      '',
      `Your free access to <b>${escapeHtml(env.GROUP_NAME)}</b> runs until <b>${escapeHtml(formatDate(subscription.expiresAt))}</b>.`,
      '',
      'Subscribe now to keep your place — any days left on your free month are added on top.',
    ].join('\n');
  }
  return [
    '\u{1F514} <b>Your subscription ends in 7 days</b>',
    '',
    `Access to <b>${escapeHtml(env.GROUP_NAME)}</b> runs out on <b>${escapeHtml(formatDate(subscription.expiresAt))}</b>.`,
    '',
    'Renew now and the days you have left are added on top — you lose nothing by renewing early.',
  ].join('\n');
}

export function reminder3Day(subscription: ISubscription): string {
  if (onTrial(subscription)) {
    return [
      '\u23F3 <b>3 days left on your free month</b>',
      '',
      `Your free access ends on <b>${escapeHtml(formatDate(subscription.expiresAt))}</b>.`,
      '',
      `After that you will be removed from the ${community()} unless you subscribe.`,
    ].join('\n');
  }
  return [
    '⏳ <b>3 days left</b>',
    '',
    `Your access ends on <b>${escapeHtml(formatDate(subscription.expiresAt))}</b>.`,
    '',
    `After that you will be removed from the ${community()} automatically. Renew below to stay in.`,
  ].join('\n');
}

export function reminder24Hour(subscription: ISubscription): string {
  if (onTrial(subscription)) {
    return [
      '\u{1F6A8} <b>Your free month ends tomorrow</b>',
      '',
      `Free access ends on <b>${escapeHtml(formatDate(subscription.expiresAt))}</b>.`,
      '',
      `Subscribe now to stay in the ${community()} — it takes two taps.`,
    ].join('\n');
  }
  return [
    '\u{1F6A8} <b>Final notice — 24 hours left</b>',
    '',
    `Your subscription ends on <b>${escapeHtml(formatDate(subscription.expiresAt))}</b>.`,
    '',
    `Unless you renew, you will be removed from the ${community()} tomorrow. Renewing takes two taps.`,
  ].join('\n');
}

export function removalNotice(subscription: ISubscription): string {
  const env = getEnv();
  if (onTrial(subscription)) {
    return [
      '\u{1F44B} <b>Your free month has ended</b>',
      '',
      `We hope you enjoyed <b>${escapeHtml(env.GROUP_NAME)}</b>. Your free access ended on <b>${escapeHtml(formatDate(subscription.expiresAt))}</b>, so you have been removed from the ${community()}.`,
      '',
      'Subscribe below and you will get a fresh invite link straight away.',
    ].join('\n');
  }
  return [
    '\u{1F44B} <b>Your access has ended</b>',
    '',
    `Your <b>${escapeHtml(subscription.planSnapshot.name)}</b> subscription expired on <b>${escapeHtml(formatDate(subscription.expiresAt))}</b>, so you have been removed from <b>${escapeHtml(env.GROUP_NAME)}</b>.`,
    '',
    'You are welcome back any time — pay again below and you will get a fresh invite link straight away.',
  ].join('\n');
}

export function trialGranted(params: { days: number; linkTtlMinutes: number; hasLink: boolean }): string {
  const env = getEnv();
  const lines = [
    '\u{1F381} <b>Good news \u2014 you qualify for free access!</b>',
    '',
    `As a member of our community, you get <b>${params.days} days free</b> in <b>${escapeHtml(env.GROUP_NAME)}</b>.`,
    '',
    `Your free month starts the moment you join the ${community()} \u2014 so there is no rush, you will not lose any days.`,
    'We will remind you before it ends, and you can subscribe any time to stay on.',
  ];
  if (params.hasLink) {
    lines.push(
      '',
      `\u26A0\uFE0F Your link works <b>once</b> and expires in <b>${params.linkTtlMinutes} minutes</b>. If it runs out, send /link for a new one.`,
    );
  } else {
    lines.push('', 'Send /link to get your invite link.');
  }
  return lines.join('\n');
}

export function trialAddedToExisting(expiresAt: Date, days: number): string {
  return [
    '\u{1F381} <b>A free month, on us</b>',
    '',
    `As a member of our community, we have added <b>${days} free days</b> to your access.`,
    `You are now covered until <b>${escapeHtml(formatDate(expiresAt))}</b>.`,
  ].join('\n');
}

export function trialClockStarted(expiresAt: Date): string {
  return `\u23F1 Your free month has started. It runs until <b>${escapeHtml(formatDate(expiresAt))}</b>.`;
}

export function helpText(): string {
  const env = getEnv();
  const lines = [
    'ℹ️ <b>Help</b>',
    '',
    '<b>Commands</b>',
    '/start — main menu',
    '/plans — see subscription plans',
    '/status — check your subscription',
    '/link — get a fresh invite link',
    '/renew — renew your subscription',
    '/help — this message',
    '',
    '<b>Common questions</b>',
    '• <i>My link says it is invalid.</i> Links work once and expire quickly. Tap /link for a new one.',
    '• <i>I paid but nothing happened.</i> Tap <b>I have paid</b> on your checkout message, or /status.',
    '• <i>Can I renew early?</i> Yes — remaining days are added to the new period.',
  ];
  if (env.SUPPORT_USERNAME) {
    lines.push('', `Still stuck? Message @${escapeHtml(env.SUPPORT_USERNAME)}.`);
  }
  return lines.join('\n');
}

export function groupWelcome(firstName: string): string {
  const env = getEnv();
  return [
    `\u{1F389} Welcome to <b>${escapeHtml(env.GROUP_NAME)}</b>, ${escapeHtml(firstName)}!`,
    '',
    '<b>House rules</b>',
    `1. No sharing of signals or content outside this ${community()}.`,
    ...(community() === 'group' ? ['2. No promotion, spam or referral links.'] : []),
    `${community() === 'group' ? '3' : '2'}. Trade responsibly — signals are educational, not financial advice.`,
    '',
    'Use /status in this bot at any time to see when your access expires.',
  ].join('\n');
}

export function unauthorisedMember(): string {
  const env = getEnv();
  return [
    '⚠️ <b>Access check</b>',
    '',
    `You were removed from <b>${escapeHtml(env.GROUP_NAME)}</b> because we could not find an active subscription for your account.`,
    '',
    'If you believe this is a mistake, contact support. Otherwise you can subscribe below.',
  ].join('\n');
}

export function adminOnly(): string {
  return '\u{1F512} This command is for administrators only.';
}

export function genericError(): string {
  return '⚠️ Something went wrong on our side. Please try again in a moment — nothing was charged.';
}
