import { Composer } from 'grammy';
import { createLogger } from '../../utils/logger';
import { isValidEmail } from '../../utils/text';
import { Plan, type Gateway, type IPlan } from '../../models';
import { enabledGateways, getGateway, isGatewayEnabled } from '../../services/payments';
import { finalizePayment, initiatePayment } from '../../services/payment.service';
import { findUsableLink } from '../../services/invite.service';
import type { BotContext } from '../context';
import {
  CB,
  backToMenuKeyboard,
  checkoutKeyboard,
  gatewayKeyboard,
  joinGroupKeyboard,
  plansKeyboard,
  subscribeKeyboard,
} from '../keyboards';
import * as texts from '../texts';
import { clearStep, render, reply, toast } from '../helpers';

const log = createLogger('bot:plans');
export const planHandlers = new Composer<BotContext>();

export async function showPlans(ctx: BotContext): Promise<void> {
  const plans = await Plan.find({ isActive: true }).sort({ sortOrder: 1, priceMinor: 1 });

  if (plans.length === 0) {
    await render(
      ctx,
      '\u{1F6A7} No subscription plans are available right now. Please check back shortly.',
      backToMenuKeyboard(),
    );
    return;
  }

  await render(ctx, texts.planList(), plansKeyboard(plans));
}

planHandlers.command('plans', async (ctx) => {
  clearStep(ctx);
  await showPlans(ctx);
});

planHandlers.hears(/^\u{1F4E6}\s*Plans$/u, async (ctx) => {
  clearStep(ctx);
  await showPlans(ctx);
});

planHandlers.callbackQuery(CB.plans, async (ctx) => {
  clearStep(ctx);
  await showPlans(ctx);
});

planHandlers.callbackQuery(/^plan:([a-f0-9]{24})$/i, async (ctx) => {
  const planId = ctx.match[1];
  const plan = await Plan.findById(planId);

  if (!plan || !plan.isActive) {
    await toast(ctx, 'That plan is no longer available.', true);
    await showPlans(ctx);
    return;
  }

  const gateways = enabledGateways();
  if (gateways.length === 0) {
    await render(ctx, '⚠️ Payments are temporarily unavailable. Please try again later.', backToMenuKeyboard());
    return;
  }

  await render(ctx, texts.planDetail(plan), gatewayKeyboard(String(plan._id), gateways));
});

// FLUTTERWAVE-DISABLED: restore to (paystack|flutterwave)
planHandlers.callbackQuery(/^pay:([a-f0-9]{24}):(paystack)$/i, async (ctx) => {
  const planId = ctx.match[1];
  const gateway = ctx.match[2].toLowerCase() as Gateway;

  if (!isGatewayEnabled(gateway)) {
    await toast(ctx, 'That payment method is unavailable.', true);
    return;
  }

  const plan = await Plan.findById(planId);
  if (!plan || !plan.isActive) {
    await toast(ctx, 'That plan is no longer available.', true);
    await showPlans(ctx);
    return;
  }

  const email = ctx.user?.email;
  if (!email || !isValidEmail(email)) {
    // Both gateways require a customer email, so collect it once and reuse it.
    ctx.session.step = 'awaiting_email';
    ctx.session.pendingCheckout = { planId: String(plan._id), gateway };
    await render(ctx, texts.askEmail());
    return;
  }

  await startCheckout(ctx, plan, gateway, email);
});

/** Shared by the button flow and the email flow. */
export async function startCheckout(
  ctx: BotContext,
  plan: IPlan,
  gateway: Gateway,
  email: string,
): Promise<void> {
  if (!ctx.user) return;

  const gatewayImpl = getGateway(gateway);
  await toast(ctx, 'Creating your secure checkout…');

  try {
    const { payment, checkoutUrl } = await initiatePayment({
      user: ctx.user,
      plan,
      gateway,
      email,
    });

    ctx.session.lastReference = payment.reference;
    ctx.session.pendingCheckout = undefined;
    ctx.session.step = undefined;

    await render(
      ctx,
      `${texts.checkoutReady(plan.name, plan.priceMinor, plan.currency, gatewayImpl.label)}\n\nReference: <code>${payment.reference}</code>`,
      checkoutKeyboard(checkoutUrl, payment.reference),
    );
  } catch (error) {
    log.error('Could not create checkout', error);
    await render(
      ctx,
      '⚠️ We could not start that payment. Please try the other payment method, or try again shortly.',
      subscribeKeyboard(),
    );
  }
}

/** Step handler: the subscriber is replying with their email address. */
export async function handleEmailStep(ctx: BotContext): Promise<boolean> {
  if (ctx.session.step !== 'awaiting_email') return false;

  const input = ctx.message?.text?.trim() ?? '';
  if (!isValidEmail(input)) {
    await reply(ctx, texts.invalidEmail());
    return true;
  }

  if (ctx.user) {
    ctx.user.email = input.toLowerCase();
    await ctx.user.save();
  }

  const pending = ctx.session.pendingCheckout;
  ctx.session.step = undefined;

  if (!pending) {
    await reply(ctx, '✅ Email saved. Choose a plan to continue.');
    await showPlans(ctx);
    return true;
  }

  const plan = await Plan.findById(pending.planId);
  if (!plan || !plan.isActive) {
    await reply(ctx, '⚠️ That plan is no longer available.');
    await showPlans(ctx);
    return true;
  }

  await startCheckout(ctx, plan, pending.gateway, input.toLowerCase());
  return true;
}

planHandlers.callbackQuery(/^check:(.+)$/, async (ctx) => {
  const reference = ctx.match[1];
  await toast(ctx, 'Checking with the payment gateway…');

  try {
    const result = await finalizePayment(reference, { trigger: 'button' });

    switch (result.outcome) {
      case 'fulfilled':
        // The confirmation message with the join button has already been sent.
        await toast(ctx, 'Payment confirmed!');
        return;

      case 'already_fulfilled': {
        const link = ctx.from ? await findUsableLink(ctx.from.id) : null;
        await render(
          ctx,
          link
            ? texts.inviteLinkMessage(link.expiresAt)
            : '✅ This payment is already confirmed. Tap /link to get a fresh invite link.',
          link ? joinGroupKeyboard(link.inviteLink) : backToMenuKeyboard(),
        );
        return;
      }

      case 'pending':
      case 'in_progress':
        await toast(ctx, 'Not confirmed yet — try again in a few seconds.', true);
        return;

      case 'amount_mismatch':
      case 'failed':
        await render(ctx, texts.paymentFailed(result.reason), subscribeKeyboard());
        return;

      case 'unknown_reference':
      default:
        await render(ctx, '⚠️ We could not find that payment. Please start a new one.', subscribeKeyboard());
    }
  } catch (error) {
    log.error('Payment check failed', error);
    await render(ctx, texts.genericError(), subscribeKeyboard());
  }
});
