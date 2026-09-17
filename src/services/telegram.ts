import { Api, GrammyError, HttpError as GrammyHttpError } from 'grammy';
import type { ChatInviteLink, Message, ChatMember } from 'grammy/types';
import { getEnv } from '../config/env';
import { createLogger } from '../utils/logger';
import { sleep } from '../utils/time';

const log = createLogger('telegram');

let cachedApi: Api | null = null;

/**
 * A standalone Api client used by background services (reminders, expiry,
 * broadcasts). Kept separate from the Bot instance so services never have to
 * import the bot — which would create an import cycle with the handlers.
 */
export function getApi(): Api {
  if (!cachedApi) cachedApi = new Api(getEnv().BOT_TOKEN);
  return cachedApi;
}

export interface SendOutcome {
  ok: boolean;
  /** The user blocked the bot, deleted their account, or never started a chat. */
  unreachable: boolean;
  error?: string;
  messageId?: number;
}

const UNREACHABLE_PATTERNS = [
  'bot was blocked by the user',
  'user is deactivated',
  'chat not found',
  'bot can\'t initiate conversation',
  'peer_id_invalid',
  'user not found',
  'bot was kicked',
];

function isUnreachable(error: unknown): boolean {
  if (!(error instanceof GrammyError)) return false;
  if (error.error_code === 403) return true;
  const description = (error.description || '').toLowerCase();
  return UNREACHABLE_PATTERNS.some((p) => description.includes(p));
}

/**
 * Runs a Telegram API call, honouring 429 `retry_after` and retrying transient
 * network failures. Returns the raw result or throws the final error.
 */
export async function callWithRetry<T>(fn: () => Promise<T>, label = 'telegram-call', maxAttempts = 4): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (error instanceof GrammyError && error.error_code === 429) {
        const retryAfter = Number(error.parameters?.retry_after ?? 1);
        log.warn(`${label} rate limited, waiting ${retryAfter}s`, { attempt });
        await sleep((retryAfter + 0.5) * 1000);
        continue;
      }

      // 5xx from Telegram, or a dropped connection: worth one more try.
      const retriable =
        error instanceof GrammyHttpError ||
        (error instanceof GrammyError && error.error_code >= 500);

      if (retriable && attempt < maxAttempts) {
        await sleep(500 * 2 ** (attempt - 1));
        continue;
      }
      throw error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`${label} failed`);
}

export async function sendMessageSafe(
  chatId: number | string,
  text: string,
  options: Parameters<Api['sendMessage']>[2] = {},
): Promise<SendOutcome> {
  try {
    const message = await callWithRetry(
      () => getApi().sendMessage(chatId, text, { parse_mode: 'HTML', ...options }),
      'sendMessage',
    );
    return { ok: true, unreachable: false, messageId: message.message_id };
  } catch (error) {
    const unreachable = isUnreachable(error);
    if (!unreachable) log.warn('sendMessage failed', { chatId, error });
    return {
      ok: false,
      unreachable,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function copyMessageSafe(
  chatId: number,
  fromChatId: number,
  messageId: number,
  options: Parameters<Api['copyMessage']>[3] = {},
): Promise<SendOutcome> {
  try {
    const result = await callWithRetry(
      () => getApi().copyMessage(chatId, fromChatId, messageId, options),
      'copyMessage',
    );
    return { ok: true, unreachable: false, messageId: result.message_id };
  } catch (error) {
    const unreachable = isUnreachable(error);
    if (!unreachable) log.warn('copyMessage failed', { chatId, error });
    return {
      ok: false,
      unreachable,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Posts an admin message into the managed group, preserving media and formatting. */
export async function copyToGroup(fromChatId: number, messageId: number): Promise<Message.CommonMessage | null> {
  const env = getEnv();
  try {
    const result = await callWithRetry(
      () => getApi().copyMessage(env.GROUP_CHAT_ID, fromChatId, messageId),
      'copyMessage:group',
    );
    return result as unknown as Message.CommonMessage;
  } catch (error) {
    log.error('Failed to post to group', error);
    return null;
  }
}

/**
 * Creates a single-use, time-limited invite link for one subscriber.
 * `member_limit: 1` is what makes the link useless once it has admitted someone.
 */
export async function createSingleUseInviteLink(name: string, expiresAt: Date): Promise<ChatInviteLink> {
  const env = getEnv();
  return callWithRetry(
    () =>
      getApi().createChatInviteLink(env.GROUP_CHAT_ID, {
        name: name.slice(0, 32),
        member_limit: 1,
        expire_date: Math.floor(expiresAt.getTime() / 1000),
      }),
    'createChatInviteLink',
  );
}

export async function revokeInviteLink(inviteLink: string): Promise<boolean> {
  const env = getEnv();
  try {
    await callWithRetry(() => getApi().revokeChatInviteLink(env.GROUP_CHAT_ID, inviteLink), 'revokeChatInviteLink');
    return true;
  } catch (error) {
    // Already revoked / expired links are not worth surfacing.
    log.debug('revokeChatInviteLink failed', error);
    return false;
  }
}

/**
 * Removes a member from the group without permanently banning them:
 * ban immediately, then unban so they can rejoin with a future paid link.
 */
export async function removeMemberFromGroup(telegramId: number): Promise<{ ok: boolean; error?: string }> {
  const env = getEnv();
  try {
    await callWithRetry(
      () => getApi().banChatMember(env.GROUP_CHAT_ID, telegramId, { revoke_messages: false }),
      'banChatMember',
    );
    // Unconditional unban, deliberately without `only_if_banned`. That flag
    // would make this a no-op if the ban had not registered yet, leaving the
    // member permanently banned and unable to rejoin after paying again.
    // Plain unbanChatMember is race-free and also removes them on its own,
    // so it doubles as a fallback if the ban above silently failed.
    await callWithRetry(
      () => getApi().unbanChatMember(env.GROUP_CHAT_ID, telegramId),
      'unbanChatMember',
    );
    return { ok: true };
  } catch (error) {
    const description = error instanceof GrammyError ? error.description : String(error);
    // Not a member any more is a success from the caller's point of view.
    if (/user not found|participant_id_invalid|member not found/i.test(description)) {
      return { ok: true };
    }
    log.error('Failed to remove member', { telegramId, error });
    return { ok: false, error: description };
  }
}

export async function getGroupMember(telegramId: number): Promise<ChatMember | null> {
  const env = getEnv();
  try {
    return await callWithRetry(() => getApi().getChatMember(env.GROUP_CHAT_ID, telegramId), 'getChatMember');
  } catch {
    return null;
  }
}

export async function isInGroup(telegramId: number): Promise<boolean> {
  const member = await getGroupMember(telegramId);
  if (!member) return false;
  return ['creator', 'administrator', 'member', 'restricted'].includes(member.status);
}

export { isUnreachable };
