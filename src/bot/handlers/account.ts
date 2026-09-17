import { Composer } from 'grammy';
import { createLogger } from '../../utils/logger';
import { getActiveSubscription, getLatestSubscription } from '../../services/subscription.service';
import { findUsableLink, issueInviteLink } from '../../services/invite.service';
import { reconcileUserPayments } from '../../services/payment.service';
import type { BotContext } from '../context';
import { CB, backToMenuKeyboard, joinGroupKeyboard, renewKeyboard, subscribeKeyboard } from '../keyboards';
import * as texts from '../texts';
import { clearStep, render, toast } from '../helpers';
import { showPlans } from './plans';

const log = createLogger('bot:account');
export const accountHandlers = new Composer<BotContext>();

async function showStatus(ctx: BotContext): Promise<void> {
  if (!ctx.from) return;

  // Someone checking their status right after paying is the most likely person
  // to have been missed by a webhook. Settle their payment before answering,
  // rather than telling them they have no subscription.
  await reconcileUserPayments(ctx.from.id);

  const active = await getActiveSubscription(ctx.from.id);
  if (active && active.expiresAt > new Date()) {
    await render(ctx, texts.subscriptionStatus(active), renewKeyboard());
    return;
  }

  const latest = await getLatestSubscription(ctx.from.id);
  if (latest) {
    await render(ctx, texts.subscriptionStatus(latest), subscribeKeyboard());
    return;
  }

  await render(ctx, texts.noActiveSubscription(), subscribeKeyboard());
}

/**
 * Re-issues an invite link for a subscriber who already paid.
 * Any previous link is revoked first, so only one can ever be live.
 */
async function sendInviteLink(ctx: BotContext): Promise<void> {
  if (!ctx.from || !ctx.user) return;

  let subscription = await getActiveSubscription(ctx.from.id);

  if (!subscription || subscription.expiresAt <= new Date()) {
    // Same reasoning as /status: check for a payment we have not acted on yet
    // before refusing someone who has genuinely paid.
    await reconcileUserPayments(ctx.from.id);
    subscription = await getActiveSubscription(ctx.from.id);
  }

  if (!subscription || subscription.expiresAt <= new Date()) {
    await render(ctx, texts.noActiveSubscription(), subscribeKeyboard());
    return;
  }

  const existing = await findUsableLink(ctx.from.id);
  if (existing) {
    await render(ctx, texts.inviteLinkMessage(existing.expiresAt), joinGroupKeyboard(existing.inviteLink));
    return;
  }

  await toast(ctx, 'Creating a fresh link…');

  try {
    const link = await issueInviteLink({ user: ctx.user, subscription });
    await render(ctx, texts.inviteLinkMessage(link.expiresAt), joinGroupKeyboard(link.inviteLink));
  } catch (error) {
    log.error('Could not issue an invite link', error);
    await render(
      ctx,
      '⚠️ We could not create your invite link. Please try again in a moment, or contact support.',
      backToMenuKeyboard(),
    );
  }
}

accountHandlers.command('status', async (ctx) => {
  clearStep(ctx);
  await showStatus(ctx);
});

accountHandlers.command('link', async (ctx) => {
  clearStep(ctx);
  await sendInviteLink(ctx);
});

accountHandlers.command('renew', async (ctx) => {
  clearStep(ctx);
  await showPlans(ctx);
});

accountHandlers.callbackQuery(CB.status, async (ctx) => {
  clearStep(ctx);
  await showStatus(ctx);
});

accountHandlers.callbackQuery(CB.link, async (ctx) => {
  clearStep(ctx);
  await sendInviteLink(ctx);
});

accountHandlers.callbackQuery(CB.renew, async (ctx) => {
  clearStep(ctx);
  await showPlans(ctx);
});

accountHandlers.hears(/^✅\s*My Subscription$/u, async (ctx) => {
  clearStep(ctx);
  await showStatus(ctx);
});

accountHandlers.hears(/^\u{1F517}\s*Invite Link$/u, async (ctx) => {
  clearStep(ctx);
  await sendInviteLink(ctx);
});
