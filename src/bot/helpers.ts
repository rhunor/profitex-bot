import { GrammyError, type InlineKeyboard } from 'grammy';
import { createLogger } from '../utils/logger';
import { chunkMessage } from '../utils/text';
import type { BotContext } from './context';

const log = createLogger('bot:helpers');

/**
 * Replaces the message a button lives on, falling back to a new message when
 * the original cannot be edited (too old, media-only, or unchanged).
 */
export async function render(ctx: BotContext, text: string, keyboard?: InlineKeyboard): Promise<void> {
  const options = {
    parse_mode: 'HTML' as const,
    reply_markup: keyboard,
    link_preview_options: { is_disabled: true },
  };

  if (ctx.callbackQuery?.message) {
    try {
      await ctx.editMessageText(text, options);
      return;
    } catch (error) {
      if (error instanceof GrammyError && error.description.includes('message is not modified')) return;
      log.debug('editMessageText failed, sending a new message instead', error);
    }
  }

  await reply(ctx, text, keyboard);
}

export async function reply(ctx: BotContext, text: string, keyboard?: InlineKeyboard): Promise<void> {
  const chunks = chunkMessage(text);
  for (let i = 0; i < chunks.length; i += 1) {
    const isLast = i === chunks.length - 1;
    await ctx.reply(chunks[i], {
      parse_mode: 'HTML',
      reply_markup: isLast ? keyboard : undefined,
      link_preview_options: { is_disabled: true },
    });
  }
}

export async function toast(ctx: BotContext, text: string, alert = false): Promise<void> {
  if (!ctx.callbackQuery) return;
  try {
    await ctx.answerCallbackQuery({ text, show_alert: alert });
  } catch {
    /* the query already expired */
  }
}

/** Clears any in-progress multi-step flow for this chat. */
export function clearStep(ctx: BotContext): void {
  ctx.session.step = undefined;
  ctx.session.admin = {};
}
