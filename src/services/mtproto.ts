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
/**
 * Both the signed-in session and every access hash belong to one specific bot
 * account — Telegram issues different access hashes to different accounts. Key
 * them by the bot's id (the part of BOT_TOKEN before the colon) so that
 * switching to a different bot can never reuse the old bot's session or hashes.
 */
function botId(): string {
  return getEnv().BOT_TOKEN.split(':')[0];
}
const sessionKey = () => `mtproto_bot_session:${botId()}`;
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

/** Test hook: run `work` against a stand-in client instead of Telegram. */
let testClient: { client: TelegramClient; api: GramApi } | null = null;
export function setTestClient(stub: { client: unknown; api: unknown } | null): void {
  testClient = stub as typeof testClient;
}

async function withClient<T>(work: (client: TelegramClient, api: GramApi) => Promise<T>): Promise<T> {
  if (testClient) return work(testClient.client, testClient.api);
  const env = getEnv();
  const { Api, TelegramClient, Logger, LogLevel, StringSession } = await loadGramJs();
  if (!env.TELEGRAM_API_ID || !env.TELEGRAM_API_HASH) {
    throw new Error('TELEGRAM_API_ID and TELEGRAM_API_HASH are not set.');
  }

  // MTPROTO_EPHEMERAL=1 (local diagnostics): use a throwaway session and never
  // touch the stored one, so a check from a laptop cannot disturb production.
  const ephemeral = process.env.MTPROTO_EPHEMERAL === '1';
  const saved = ephemeral ? null : await readSetting(sessionKey());
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
      if (!ephemeral) await writeSetting(sessionKey(), (client.session as StringSession).save());
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

const channelHashKey = (chatId: number) => `mtproto_channel_hash:${botId()}:${chatId}`;

type GramApi = typeof Api;

function rpcMessage(error: unknown): string {
  return (error as { errorMessage?: string }).errorMessage ?? (error instanceof Error ? error.message : String(error));
}

/**
 * Turns a Bot API chat id into an InputChannel carrying the channel's *real*
 * access hash.
 *
 * A fresh full-API session has never "seen" the channel, so it holds no access
 * hash. Sending a zero hash straight to channels.getParticipant is rejected
 * with CHANNEL_INVALID. Instead, ask for the channel itself with a zero hash —
 * the route Telegram documents for bots — which returns the full hash, then
 * use that. The hash is stable, so it is stored and fetched only once.
 */
async function resolveChannel(
  client: TelegramClient,
  api: GramApi,
  chatId: number,
  options: { useCache?: boolean } = {},
): Promise<Api.InputChannel> {
  const channelId = toMtprotoChannelId(chatId);
  const useCache = options.useCache !== false;

  if (useCache) {
    const cached = await readSetting(channelHashKey(chatId));
    if (cached) return new api.InputChannel({ channelId, accessHash: bigInt(cached) });
  }

  const result = await client.invoke(
    new api.channels.GetChannels({ id: [new api.InputChannel({ channelId, accessHash: bigInt.zero })] }),
  );
  const channel = result.chats.find(
    (chat): chat is Api.Channel => chat.className === 'Channel' && chat.id.equals(channelId),
  );
  if (!channel) throw new Error('Telegram did not return the channel. Is the bot a member of it?');
  if (channel.min || !channel.accessHash) {
    throw new Error('Telegram returned only a partial ("min") channel, with no usable access hash.');
  }

  if (useCache) await writeSetting(channelHashKey(chatId), channel.accessHash.toString());
  return new api.InputChannel({ channelId, accessHash: channel.accessHash });
}

/** Same idea for the person: fetch them with a zero hash to learn their real one. */
async function resolveUser(client: TelegramClient, api: GramApi, userId: number): Promise<Api.InputPeerUser> {
  const users = await client.invoke(
    new api.users.GetUsers({ id: [new api.InputUser({ userId: bigInt(userId), accessHash: bigInt.zero })] }),
  );
  const user = users.find((u): u is Api.User => u.className === 'User' && u.id.equals(bigInt(userId)));
  if (!user || user.min || !user.accessHash) {
    // Fall back to the zero hash; getParticipant will say clearly if that fails.
    return new api.InputPeerUser({ userId: bigInt(userId), accessHash: bigInt.zero });
  }
  return new api.InputPeerUser({ userId: user.id, accessHash: user.accessHash });
}

async function getParticipant(client: TelegramClient, api: GramApi, chatId: number, userId: number) {
  const participant = await resolveUser(client, api, userId);
  try {
    const channel = await resolveChannel(client, api, chatId);
    return await client.invoke(new api.channels.GetParticipant({ channel, participant }));
  } catch (error) {
    // A stored hash can go stale (e.g. the bot was removed and re-added).
    // Forget it and try once more with a freshly fetched one.
    if (rpcMessage(error) === 'CHANNEL_INVALID') {
      await writeSetting(channelHashKey(chatId), '');
      const channel = await resolveChannel(client, api, chatId, { useCache: false });
      await writeSetting(channelHashKey(chatId), channel.accessHash.toString());
      return client.invoke(new api.channels.GetParticipant({ channel, participant }));
    }
    throw error;
  }
}

/**
 * Is `userId` in `chatId`, and since when?
 *
 * Uses `channels.getParticipant`, which fetches one member rather than listing
 * them, so Telegram's ~200-subscriber listing cap on channels does not apply.
 */
export async function lookupMembership(chatId: number, userId: number): Promise<Membership> {
  try {
    return await withTimeout(
      withClient(async (client, api) => interpretParticipant((await getParticipant(client, api, chatId, userId)).participant)),
      LOOKUP_TIMEOUT_MS,
    );
  } catch (error) {
    const message = rpcMessage(error);

    // Only this error means "not in the chat". Anything else — including
    // PARTICIPANT_ID_INVALID, which a bad access hash can also cause — is a
    // failure of the lookup, and must alert the admins rather than quietly
    // turning an eligible member away.
    if (message === 'USER_NOT_PARTICIPANT') return { status: 'not_member' };

    log.error('Membership lookup failed', { chatId, userId, message });
    return { status: 'error', reason: message };
  }
}

/** Signs in (if needed) and reads the source chat, to prove the setup works. */
export async function verifyTrialSourceAccess(chatId: number): Promise<{ ok: boolean; title?: string; reason?: string }> {
  try {
    return await withTimeout(
      withClient(async (client, api) => {
        const channel = await resolveChannel(client, api, chatId);
        const result = await client.invoke(new api.channels.GetChannels({ id: [channel] }));
        const chat = result.chats[0] as { title?: string } | undefined;
        return { ok: true, title: chat?.title };
      }),
      LOOKUP_TIMEOUT_MS,
    );
  } catch (error) {
    return { ok: false, reason: rpcMessage(error) };
  }
}

export interface DiagnosisStep {
  step: string;
  ok: boolean;
  detail: string;
}

/**
 * Runs the lookup one step at a time and reports each, so a failure on the live
 * deployment says exactly where and why — no guessing, no redeploy loops.
 * Read-only: grants nothing, and bypasses the stored channel hash.
 */
export async function diagnoseLookup(chatId: number, userId?: number): Promise<DiagnosisStep[]> {
  const steps: DiagnosisStep[] = [];
  try {
    await withTimeout(
      withClient(async (client, api) => {
        steps.push({ step: 'sign in to the full API as the bot', ok: true, detail: 'signed in' });

        let channel: Api.InputChannel;
        try {
          channel = await resolveChannel(client, api, chatId, { useCache: false });
          steps.push({ step: 'fetch the group and its access hash', ok: true, detail: 'full access hash received' });
        } catch (error) {
          steps.push({ step: 'fetch the group and its access hash', ok: false, detail: rpcMessage(error) });
          return;
        }

        if (!userId) return;

        const participant = await resolveUser(client, api, userId).catch((error) => {
          steps.push({ step: 'fetch the person', ok: false, detail: rpcMessage(error) });
          return null;
        });
        if (!participant) return;
        steps.push({
          step: 'fetch the person',
          ok: true,
          detail: participant.accessHash.isZero() ? 'no full access hash; trying with zero' : 'full access hash received',
        });

        try {
          const result = await client.invoke(new api.channels.GetParticipant({ channel, participant }));
          const membership = interpretParticipant(result.participant);
          steps.push({
            step: 'read their membership',
            ok: true,
            detail:
              membership.status === 'member'
                ? `member (${membership.role}), joined ${membership.joinedAt ? membership.joinedAt.toISOString() : 'no date (creator)'}`
                : membership.status,
          });
        } catch (error) {
          const message = rpcMessage(error);
          steps.push({
            step: 'read their membership',
            ok: message === 'USER_NOT_PARTICIPANT',
            detail: message === 'USER_NOT_PARTICIPANT' ? 'not a member of the group' : message,
          });
        }
      }),
      LOOKUP_TIMEOUT_MS,
    );
  } catch (error) {
    steps.push({ step: steps.length ? 'lookup' : 'sign in to the full API as the bot', ok: false, detail: rpcMessage(error) });
  }
  return steps;
}
