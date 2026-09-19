import bigInt from 'big-integer';
// Types only: the library itself is loaded on demand (see loadGramJs), because
// requiring it costs ~280ms and would otherwise slow every cold start — even
// requests that have nothing to do with the free month.
import type { Api, TelegramClient } from 'telegram';
import type { StringSession } from 'telegram/sessions';
import { getEnv } from '../config/env';
import { readSetting, writeSetting } from '../models/AppSetting';
import { createLogger } from '../utils/logger';

/*
 * Telegram's full API (MTProto), used for exactly one thing: reading the date
 * someone joined a channel or group. The Bot API used everywhere else in this
 * project exposes no join dates at all.
 *
 * We sign in *as the bot* — no personal account involved — with an api id/hash
 * from my.telegram.org. The signed-in session is stored in MongoDB so a
 * serverless cold start reuses it instead of signing in again, which Telegram
 * rate-limits.
 */

const log = createLogger('mtproto');
const SESSION_KEY = 'mtproto_bot_session';
const LOOKUP_TIMEOUT_MS = 20_000;

export type Membership =
  /** In the chat. `joinedAt` is null only for the creator, who has no join date. */
  | { status: 'member'; joinedAt: Date | null; role: 'member' | 'admin' | 'creator' }
  /** Never joined, left, or was removed. */
  | { status: 'not_member' }
  /** The lookup itself failed — configuration or connectivity, not the user. */
  | { status: 'error'; reason: string };

/**
 * Bot API ids for channels and supergroups are the MTProto channel id prefixed
 * with -100: -1001234567890 is channel 1234567890.
 */
export function toMtprotoChannelId(botApiChatId: number): bigInt.BigInteger {
  const text = String(botApiChatId);
  if (!text.startsWith('-100')) {
    throw new Error(`${botApiChatId} is not a channel or supergroup id (expected it to start with -100).`);
  }
  return bigInt(text.slice(4));
}

/** Maps Telegram's participant constructors onto a plain answer. Pure, so it is unit-tested. */
export function interpretParticipant(participant: Api.TypeChannelParticipant): Membership {
  const at = (seconds: number) => new Date(seconds * 1000);

  switch (participant.className) {
    case 'ChannelParticipant':
    case 'ChannelParticipantSelf':
      return { status: 'member', joinedAt: at(participant.date), role: 'member' };
    case 'ChannelParticipantAdmin':
      // For an admin, `date` is when they were promoted — the closest thing to
      // a join date Telegram records for them.
      return { status: 'member', joinedAt: at(participant.date), role: 'admin' };
    case 'ChannelParticipantCreator':
      return { status: 'member', joinedAt: null, role: 'creator' };
    case 'ChannelParticipantBanned':
    case 'ChannelParticipantLeft':
      return { status: 'not_member' };
    default:
      return { status: 'error', reason: `Unexpected participant type ${(participant as { className?: string }).className}` };
  }
}

async function loadGramJs() {
  const [{ Api, TelegramClient }, { Logger, LogLevel }, { StringSession }] = await Promise.all([
    import('telegram'),
    import('telegram/extensions/Logger'),
    import('telegram/sessions'),
  ]);
  return { Api, TelegramClient, Logger, LogLevel, StringSession };
}

async function withClient<T>(work: (client: TelegramClient, api: typeof Api) => Promise<T>): Promise<T> {
  const env = getEnv();
  const { Api, TelegramClient, Logger, LogLevel, StringSession } = await loadGramJs();
  if (!env.TELEGRAM_API_ID || !env.TELEGRAM_API_HASH) {
    throw new Error('TELEGRAM_API_ID and TELEGRAM_API_HASH are not set.');
  }

  const saved = await readSetting(SESSION_KEY);
  const client = new TelegramClient(new StringSession(saved ?? ''), env.TELEGRAM_API_ID, env.TELEGRAM_API_HASH, {
    connectionRetries: 2,
    autoReconnect: false,
    baseLogger: new Logger(LogLevel.ERROR),
  });

  try {
    await client.connect();

    if (!(await client.checkAuthorization())) {
      log.info('Signing in to the full API as the bot (first use, or the saved session expired)');
      await client.signInBot(
        { apiId: env.TELEGRAM_API_ID, apiHash: env.TELEGRAM_API_HASH },
        { botAuthToken: env.BOT_TOKEN },
      );
      await writeSetting(SESSION_KEY, (client.session as StringSession).save());
    }

    return await work(client, Api);
  } finally {
    // destroy() also stops the update loop, so the process is free to finish.
    await client.destroy().catch(() => undefined);
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Is `userId` in `chatId`, and since when?
 *
 * Uses `channels.getParticipant`, which fetches one member rather than listing
 * them, so Telegram's ~200-subscriber listing cap on channels does not apply.
 * Both ids use a zero access hash, which is what Telegram tells bots to do when
 * they hold no full access hash (core.telegram.org/api/peers).
 */
export async function lookupMembership(chatId: number, userId: number): Promise<Membership> {
  try {
    return await withTimeout(
      withClient(async (client, Api) => {
        const result = await client.invoke(
          new Api.channels.GetParticipant({
            channel: new Api.InputChannel({ channelId: toMtprotoChannelId(chatId), accessHash: bigInt.zero }),
            participant: new Api.InputPeerUser({ userId: bigInt(userId), accessHash: bigInt.zero }),
          }),
        );
        return interpretParticipant(result.participant);
      }),
      LOOKUP_TIMEOUT_MS,
    );
  } catch (error) {
    const message = (error as { errorMessage?: string }).errorMessage ?? (error instanceof Error ? error.message : String(error));

    // Telegram's way of saying "this person is not in that chat".
    if (message === 'USER_NOT_PARTICIPANT' || message === 'PARTICIPANT_ID_INVALID') {
      return { status: 'not_member' };
    }

    log.error('Membership lookup failed', { chatId, userId, message });
    return { status: 'error', reason: message };
  }
}

/** Signs in (if needed) and reads the source chat, to prove the setup works. */
export async function verifyTrialSourceAccess(chatId: number): Promise<{ ok: boolean; title?: string; reason?: string }> {
  try {
    return await withTimeout(
      withClient(async (client, Api) => {
        const result = await client.invoke(
          new Api.channels.GetChannels({
            id: [new Api.InputChannel({ channelId: toMtprotoChannelId(chatId), accessHash: bigInt.zero })],
          }),
        );
        const chat = result.chats[0] as { title?: string } | undefined;
        return { ok: true, title: chat?.title };
      }),
      LOOKUP_TIMEOUT_MS,
    );
  } catch (error) {
    const message = (error as { errorMessage?: string }).errorMessage ?? (error instanceof Error ? error.message : String(error));
    return { ok: false, reason: message };
  }
}
