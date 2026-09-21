import type { Context, SessionFlavor } from 'grammy';
import type { Gateway, IUser } from '../models';

export interface AdminSessionState {
  broadcastAudience?: 'all' | 'active' | 'expired';
  broadcastMessage?: { chatId: number; messageId: number; preview: string };
  dmTargetTelegramId?: number;
  grantTargetTelegramId?: number;
  planId?: string;
  /** Where an in-progress /post will be sent. */
  postTargetChatId?: number;
}

export interface SessionData {
  /** Name of the multi-step flow this chat is currently in, if any. */
  step?: string;
  /** Checkout in progress, remembered while we ask for an email address. */
  pendingCheckout?: { planId: string; gateway: Gateway };
  lastReference?: string;
  admin?: AdminSessionState;
}

export function initialSession(): SessionData {
  return {};
}

export type BotContext = Context &
  SessionFlavor<SessionData> & {
    /** The local record for ctx.from, attached by the attachUser middleware. */
    user?: IUser;
    isAdmin: boolean;
  };
