import type { NextFunction } from 'grammy';
import { getEnv } from '../config/env';
import { connectToDatabase } from '../db/connect';
import { createLogger } from '../utils/logger';
import { upsertUser } from '../services/user.service';
import { adminOnly } from './texts';
import type { BotContext } from './context';

const log = createLogger('bot:mw');

/**
 * Discards group and channel traffic the bot never acts on — before it costs a
 * database connection.
 *
 * A bot that is an admin receives *every* message posted in a group, privacy
 * mode or not (core.telegram.org/bots/features#privacy-mode). Being an admin in
 * a busy community (such as the free-month source group) would otherwise turn
 * each chat message into a function invocation plus database writes.
 *
 * Kept: everything in private chats; membership changes in the paid channel;
 * and `my_chat_member` anywhere, which is how the bot reports a chat's id.
 */
export function isIgnorableUpdate(ctx: Pick<BotContext, 'chat' | 'update'>, paidChatId: number): boolean {
  const chat = ctx.chat;
  if (!chat || chat.type === 'private') return false;

  const update = ctx.update;
  if (update.message || update.edited_message || update.channel_post || update.edited_channel_post) return true;
  if ((update.chat_member || update.chat_join_request) && chat.id !== paidChatId) return true;
  return false;
}

export async function dropIgnorableUpdates(ctx: BotContext, next: NextFunction): Promise<void> {
  if (isIgnorableUpdate(ctx, getEnv().GROUP_CHAT_ID)) return;
  await next();
}

/** Guarantees a live database connection before any handler runs. */
export async function ensureDatabase(_ctx: BotContext, next: NextFunction): Promise<void> {
  await connectToDatabase();
  await next();
}

/** Attaches the local user record and admin flag to every update. */
export async function attachUser(ctx: BotContext, next: NextFunction): Promise<void> {
  ctx.isAdmin = false;

  if (ctx.from && !ctx.from.is_bot) {
    try {
      const user = await upsertUser({
        id: ctx.from.id,
        first_name: ctx.from.first_name,
        last_name: ctx.from.last_name,
        username: ctx.from.username,
        language_code: ctx.from.language_code,
      });
      ctx.user = user;
      ctx.isAdmin = user.isAdmin || getEnv().adminIds.has(ctx.from.id);
    } catch (error) {
      log.error('Could not attach user', error);
    }
  }

  await next();
}

/** Blocks non-admins from administrator handlers. */
export async function requireAdmin(ctx: BotContext, next: NextFunction): Promise<void> {
  if (!ctx.isAdmin) {
    if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: 'Admins only.', show_alert: true });
    else await ctx.reply(adminOnly(), { parse_mode: 'HTML' });
    return;
  }
  await next();
}

/**
 * Answers callback queries automatically so the client never shows a spinner,
 * even when a handler forgets. Safe to call twice — the second is ignored.
 */
export async function autoAnswerCallback(ctx: BotContext, next: NextFunction): Promise<void> {
  await next();
  if (ctx.callbackQuery) {
    try {
      await ctx.answerCallbackQuery();
    } catch {
      /* already answered, or the query expired */
    }
  }
}

/** Ignores anything the bot itself or another bot sends. */
export async function ignoreBots(ctx: BotContext, next: NextFunction): Promise<void> {
  if (ctx.from?.is_bot) return;
  await next();
}
