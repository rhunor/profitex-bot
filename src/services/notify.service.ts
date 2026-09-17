import { getEnv } from '../config/env';
import { createLogger } from '../utils/logger';
import * as texts from '../bot/texts';
import { joinGroupKeyboard, renewKeyboard, subscribeKeyboard } from '../bot/keyboards';
import { recordActivity, type IInviteLink, type ISubscription, type ReminderKey } from '../models';
import { sendMessageSafe } from './telegram';
import { markUnreachable } from './user.service';

const log = createLogger('notify');

async function deliver(telegramId: number, text: string, keyboard?: ReturnType<typeof subscribeKeyboard>): Promise<boolean> {
  const outcome = await sendMessageSafe(telegramId, text, {
    reply_markup: keyboard,
    link_preview_options: { is_disabled: true },
  });

  if (!outcome.ok && outcome.unreachable) {
    await markUnreachable(telegramId);
    log.warn('Subscriber is unreachable', { telegramId });
  }

  return outcome.ok;
}

export async function notifyAccessGranted(params: {
  telegramId: number;
  subscription: ISubscription;
  inviteLink: IInviteLink | null;
  isRenewal: boolean;
}): Promise<void> {
  const env = getEnv();

  const body = texts.accessGranted({
    planName: params.subscription.planSnapshot.name,
    expiresAt: params.subscription.expiresAt,
    isRenewal: params.isRenewal,
    linkTtlMinutes: env.INVITE_LINK_TTL_MINUTES,
  });

  await deliver(
    params.telegramId,
    body,
    params.inviteLink ? joinGroupKeyboard(params.inviteLink.inviteLink) : undefined,
  );
}

const REMINDER_BUILDERS: Record<ReminderKey, (s: ISubscription) => string> = {
  d7: texts.reminder7Day,
  d3: texts.reminder3Day,
  h24: texts.reminder24Hour,
};

export async function notifyReminder(subscription: ISubscription, key: ReminderKey): Promise<boolean> {
  const sent = await deliver(subscription.telegramId, REMINDER_BUILDERS[key](subscription), renewKeyboard());
  if (sent) {
    recordActivity({
      action: 'reminder.sent',
      telegramId: subscription.telegramId,
      message: `${key} reminder`,
      meta: { expiresAt: subscription.expiresAt },
    });
  }
  return sent;
}

export async function notifyRemoval(subscription: ISubscription): Promise<boolean> {
  return deliver(subscription.telegramId, texts.removalNotice(subscription), subscribeKeyboard());
}

export async function notifyUnauthorisedRemoval(telegramId: number): Promise<boolean> {
  return deliver(telegramId, texts.unauthorisedMember(), subscribeKeyboard());
}

export async function notifyAdmins(text: string): Promise<void> {
  const { listAdminIds } = await import('./user.service');
  const admins = await listAdminIds();
  await Promise.all(admins.map((id) => sendMessageSafe(id, text)));
}
