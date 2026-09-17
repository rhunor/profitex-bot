import { Bot, GrammyError, HttpError, session } from 'grammy';
import { getEnv } from '../config/env';
import { createLogger } from '../utils/logger';
import { initialSession, type BotContext, type SessionData } from './context';
import { MongoSessionStorage } from './session-storage';
import { attachUser, autoAnswerCallback, ensureDatabase, ignoreBots } from './middlewares';
import { startHandlers } from './handlers/start';
import { planHandlers, handleEmailStep } from './handlers/plans';
import { accountHandlers } from './handlers/account';
import { groupHandlers } from './handlers/group';
import { adminHandlers, handleAdminStep } from './admin';
import { mainMenuKeyboard } from './keyboards';
import * as texts from './texts';
import { reply } from './helpers';

const log = createLogger('bot');

/** Update types the bot must receive. `chat_member` is opt-in on Telegram's side. */
export const ALLOWED_UPDATES = [
  'message',
  'edited_message',
  'callback_query',
  'my_chat_member',
  'chat_member',
  'chat_join_request',
] as const;

let cachedBot: Bot<BotContext> | null = null;

export function createBot(): Bot<BotContext> {
  const env = getEnv();
  const bot = new Bot<BotContext>(env.BOT_TOKEN);

  bot.use(ensureDatabase);

  bot.use(
    session<SessionData, BotContext>({
      initial: initialSession,
      storage: new MongoSessionStorage(),
      // One session per chat. Private chats are where every flow happens.
      getSessionKey: (ctx) => (ctx.chat ? `chat:${ctx.chat.id}` : ctx.from ? `user:${ctx.from.id}` : undefined),
    }),
  );

  bot.use(ignoreBots);
  bot.use(attachUser);
  bot.use(autoAnswerCallback);

  // Group membership changes first: they never carry a session-driven step.
  bot.use(groupHandlers);

  // Every conversational flow belongs in a one-to-one chat with the bot.
  // Keeping them out of the group stops /status or a member list from ever
  // being answered in front of everyone.
  const privateChat = bot.filter((ctx) => ctx.chat?.type === 'private');

  // Admin routes take precedence so an admin command always escapes a flow.
  privateChat.use(adminHandlers);

  privateChat.use(startHandlers);
  privateChat.use(planHandlers);
  privateChat.use(accountHandlers);

  // Anything left is either a reply to a multi-step prompt, or unrecognised.
  bot.on('message', async (ctx) => {
    if (ctx.chat.type !== 'private') return;

    if (await handleEmailStep(ctx)) return;
    if (await handleAdminStep(ctx)) return;

    await reply(ctx, texts.mainMenuHint(), mainMenuKeyboard(false));
  });

  bot.catch((error) => {
    const ctx = error.ctx;
    const err = error.error;

    if (err instanceof GrammyError) {
      log.error(`Telegram rejected a request while handling update ${ctx.update.update_id}`, {
        method: err.method,
        description: err.description,
      });
    } else if (err instanceof HttpError) {
      log.error('Could not reach Telegram', err);
    } else {
      log.error(`Unhandled error while handling update ${ctx.update.update_id}`, err);
    }

    // Best effort: tell the user something went wrong rather than going silent.
    if (ctx.chat?.type === 'private') {
      void ctx.reply(texts.genericError(), { parse_mode: 'HTML' }).catch(() => undefined);
    }
  });

  return bot;
}

/**
 * Returns a process-wide bot instance, initialised and ready to handle updates.
 * Caching matters on serverless, where every cold start would otherwise pay for
 * another getMe round trip.
 */
export async function getBot(): Promise<Bot<BotContext>> {
  if (!cachedBot) {
    cachedBot = createBot();
  }
  if (!cachedBot.isInited()) {
    await cachedBot.init();
  }
  return cachedBot;
}

/** Registers the command list shown in Telegram's UI. */
export async function publishCommands(bot: Bot<BotContext>): Promise<void> {
  await bot.api.setMyCommands(
    [
      { command: 'start', description: 'Open the main menu' },
      { command: 'plans', description: 'See subscription plans' },
      { command: 'status', description: 'Check your subscription' },
      { command: 'link', description: 'Get your invite link' },
      { command: 'renew', description: 'Renew your subscription' },
      { command: 'help', description: 'Help and support' },
    ],
    { scope: { type: 'all_private_chats' } },
  );

  const env = getEnv();
  for (const adminId of env.adminIds) {
    try {
      await bot.api.setMyCommands(
        [
          { command: 'start', description: 'Open the main menu' },
          { command: 'admin', description: 'Admin dashboard' },
          { command: 'stats', description: 'Overview' },
          { command: 'members', description: 'Active subscribers' },
          { command: 'payments', description: 'Payment history' },
          { command: 'find', description: 'Look up a member' },
          { command: 'grant', description: 'Grant or extend access' },
          { command: 'revoke', description: 'Revoke access' },
          { command: 'dm', description: 'Message one member' },
          { command: 'post', description: `Post to the ${texts.community()}` },
          { command: 'broadcast', description: 'Message many members' },
          { command: 'cron', description: 'Run the maintenance pass' },
        ],
        { scope: { type: 'chat', chat_id: adminId } },
      );
    } catch (error) {
      log.warn(`Could not set admin commands for ${adminId}`, error);
    }
  }
}
