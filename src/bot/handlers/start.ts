import { Composer } from 'grammy';
import { createLogger } from '../../utils/logger';
import { getActiveSubscription } from '../../services/subscription.service';
import { finalizePayment } from '../../services/payment.service';
import type { BotContext } from '../context';
import { CB, mainMenuKeyboard, persistentMenu } from '../keyboards';
import * as texts from '../texts';
import { clearStep, render, reply } from '../helpers';

const log = createLogger('bot:start');
export const startHandlers = new Composer<BotContext>();

async function showMenu(ctx: BotContext, greeting = false): Promise<void> {
  const active = ctx.from ? await getActiveSubscription(ctx.from.id) : null;
  const hasActive = Boolean(active && active.expiresAt > new Date());
  const body = greeting ? texts.welcome(ctx.from?.first_name) : texts.mainMenuHint();
  await render(ctx, body, mainMenuKeyboard(hasActive));
}

startHandlers.command('start', async (ctx) => {
  clearStep(ctx);

  const payload = ctx.match?.toString().trim();

  // Deep link back from the payment redirect: /start ref_<reference>
  if (payload?.startsWith('ref_')) {
    const reference = payload.slice(4);
    await ctx.reply('⏳ Checking your payment…');
    try {
      const result = await finalizePayment(reference, { trigger: 'deep-link' });
      if (result.outcome === 'fulfilled' || result.outcome === 'already_fulfilled') {
        // finalizePayment already sent the confirmation with the join button.
        if (result.outcome === 'already_fulfilled') {
          await reply(ctx, '✅ This payment is already confirmed. Use /link if you need your invite link again.');
        }
        return;
      }
      if (result.outcome === 'pending' || result.outcome === 'in_progress') {
        await reply(ctx, texts.paymentPending());
        return;
      }
      await reply(ctx, texts.paymentFailed(result.reason));
      return;
    } catch (error) {
      log.error('Deep-link verification failed', error);
      await reply(ctx, texts.genericError());
      return;
    }
  }

  await ctx.reply(texts.welcome(ctx.from?.first_name), {
    parse_mode: 'HTML',
    reply_markup: persistentMenu(),
    link_preview_options: { is_disabled: true },
  });
  await showMenu(ctx);
});

startHandlers.command('help', async (ctx) => {
  clearStep(ctx);
  await reply(ctx, texts.helpText());
});

startHandlers.callbackQuery(CB.menu, async (ctx) => {
  clearStep(ctx);
  await showMenu(ctx);
});

startHandlers.callbackQuery(CB.help, async (ctx) => {
  await render(ctx, texts.helpText(), mainMenuKeyboard(false));
});

startHandlers.hears(/^ℹ️\s*Help$/, async (ctx) => {
  await reply(ctx, texts.helpText());
});

export { showMenu };
