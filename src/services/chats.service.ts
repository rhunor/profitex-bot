import { getEnv } from '../config/env';
import { createLogger } from '../utils/logger';
import { ManagedChat, type IManagedChat } from '../models/ManagedChat';
import { callWithRetry, getApi } from './telegram';

const log = createLogger('chats');

/** Which of the configured chats this is, if any — used only for labelling. */
function roleOf(chatId: number): 'paid' | 'trial-source' | undefined {
  const env = getEnv();
  if (env.groupConfigured && chatId === env.GROUP_CHAT_ID) return 'paid';
  if (chatId === env.TRIAL_SOURCE_CHAT_ID) return 'trial-source';
  return undefined;
}

/**
 * A channel needs can_post_messages; in a group, any admin can send messages.
 * Being merely a member is never enough for posting through the bot.
 */
function canPost(type: string, status: string, rights: { can_post_messages?: boolean }): boolean {
  if (status !== 'administrator') return false;
  return type === 'channel' ? Boolean(rights.can_post_messages) : true;
}

export async function rememberChat(
  chat: { id: number; type: string; title?: string },
  botStatus: string,
  rights: { can_post_messages?: boolean } = {},
): Promise<void> {
  if (!['group', 'supergroup', 'channel'].includes(chat.type)) return;

  await ManagedChat.updateOne(
    { chatId: chat.id },
    {
      $set: {
        title: chat.title ?? `Chat ${chat.id}`,
        type: chat.type,
        botStatus,
        canPost: canPost(chat.type, botStatus, rights),
        role: roleOf(chat.id) ?? null,
        lastCheckedAt: new Date(),
      },
    },
    { upsert: true },
  );
}

/** Asks Telegram about one chat and stores what it says. */
export async function refreshChat(chatId: number): Promise<IManagedChat | null> {
  try {
    const api = getApi();
    const [chat, me] = await Promise.all([
      callWithRetry(() => api.getChat(chatId), 'getChat'),
      callWithRetry(() => api.getMe(), 'getMe'),
    ]);
    const member = await callWithRetry(() => api.getChatMember(chatId, me.id), 'getChatMember');

    await rememberChat(
      { id: chat.id, type: chat.type, title: 'title' in chat ? chat.title : undefined },
      member.status,
      member.status === 'administrator' ? member : {},
    );
    return ManagedChat.findOne({ chatId });
  } catch (error) {
    log.warn('Could not refresh a chat', { chatId, error });
    return null;
  }
}

/**
 * Chats the bot can post in, with the configured ones included even if they
 * predate this record-keeping (the bot was added before it existed).
 */
export async function listPostableChats(): Promise<IManagedChat[]> {
  const env = getEnv();

  const configured = [env.groupConfigured ? env.GROUP_CHAT_ID : null, env.TRIAL_SOURCE_CHAT_ID ?? null].filter(
    (id): id is number => typeof id === 'number',
  );
  for (const chatId of configured) {
    if (!(await ManagedChat.exists({ chatId }))) await refreshChat(chatId);
  }

  return ManagedChat.find({ canPost: true }).sort({ role: 1, title: 1 });
}

export { ManagedChat };
