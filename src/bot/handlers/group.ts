import { Composer } from 'grammy';
import { getEnv } from '../../config/env';
import { createLogger } from '../../utils/logger';
import { recordActivity } from '../../models';
import { getActiveSubscription } from '../../services/subscription.service';
import { markLinkUsed } from '../../services/invite.service';
import { setGroupMembership } from '../../services/user.service';
import { removeMemberFromGroup, sendMessageSafe } from '../../services/telegram';
import { notifyAdmins, notifyUnauthorisedRemoval } from '../../services/notify.service';
import { startTrialClockOnJoin } from '../../services/trial.service';
import { rememberChat } from '../../services/chats.service';
import { escapeHtml } from '../../utils/text';
import type { BotContext } from '../context';
import * as texts from '../texts';

const log = createLogger('bot:group');
export const groupHandlers = new Composer<BotContext>();

const MEMBER_STATUSES = new Set(['member', 'administrator', 'creator', 'restricted']);
const GONE_STATUSES = new Set(['left', 'kicked']);

/**
 * Ties every arrival in the group back to a real subscription.
 *
 * Telegram reports which invite link admitted the user, so a join through a
 * link we issued is matched to its payment. Anyone who appears without an
 * active subscription is removed again (when enforcement is switched on).
 */
groupHandlers.on('chat_member', async (ctx) => {
  const env = getEnv();
  if (ctx.chat?.id !== env.GROUP_CHAT_ID) return;

  const update = ctx.chatMember;
  const member = update.new_chat_member;
  const previous = update.old_chat_member;
  const telegramId = member.user.id;

  if (member.user.is_bot) return;

  const joined = !MEMBER_STATUSES.has(previous.status) && MEMBER_STATUSES.has(member.status);
  const left = MEMBER_STATUSES.has(previous.status) && GONE_STATUSES.has(member.status);

  if (left) {
    await setGroupMembership(telegramId, false);
    log.info('Member left the group', { telegramId });
    return;
  }

  if (!joined) return;

  await setGroupMembership(telegramId, true);

  const usedLink = update.invite_link?.invite_link;
  if (usedLink) {
    const matched = await markLinkUsed(usedLink, telegramId);
    if (matched && matched.telegramId !== telegramId) {
      // The link was issued to someone else and then forwarded.
      log.warn('Invite link used by a different account', {
        issuedTo: matched.telegramId,
        usedBy: telegramId,
      });
      recordActivity({
        action: 'member.unauthorised',
        telegramId,
        message: `Used a link issued to ${matched.telegramId}`,
      });
    }
  }

  const subscription = await getActiveSubscription(telegramId);
  const hasAccess = Boolean(subscription && subscription.expiresAt > new Date());

  if (!hasAccess) {
    recordActivity({
      action: 'member.unauthorised',
      telegramId,
      message: 'Joined without an active subscription',
    });

    if (env.ENFORCE_PAID_MEMBERS_ONLY) {
      const removal = await removeMemberFromGroup(telegramId);
      if (removal.ok) {
        await setGroupMembership(telegramId, false);
        await notifyUnauthorisedRemoval(telegramId);
        log.info('Removed an unpaid joiner', { telegramId });
      }
      return;
    }

    log.warn('Unpaid member joined (enforcement is off)', { telegramId });
    return;
  }

  recordActivity({ action: 'member.joined', telegramId, message: 'Joined with an active subscription' });

  // A free month counts from this moment, not from when it was claimed.
  const trialStarted = await startTrialClockOnJoin(telegramId, new Date(update.date * 1000));

  // Welcome in DM rather than the group, so the group stays signal-only.
  await sendMessageSafe(telegramId, texts.groupWelcome(member.user.first_name ?? 'trader'));
  if (trialStarted) {
    await sendMessageSafe(telegramId, texts.trialClockStarted(trialStarted.expiresAt));
  }
});

/** Keeps the local record straight when someone joins via the group UI. */
groupHandlers.on('my_chat_member', async (ctx) => {
  const env = getEnv();
  const chat = ctx.chat;

  // Keep the list of chats the bot belongs to up to date; it is the only way
  // to offer a choice of where to post, since the Bot API cannot list them.
  if (chat && chat.type !== 'private') {
    const member = ctx.myChatMember.new_chat_member;
    await rememberChat(
      { id: chat.id, type: chat.type, title: 'title' in chat ? chat.title : undefined },
      member.status,
      member.status === 'administrator' ? member : {},
    );
  }

  // Added to a group that is not the managed one (typically: the group has not
  // been configured yet). Tell the admins its id, so connecting the group never
  // needs a terminal.
  if (chat && chat.id === env.TRIAL_SOURCE_CHAT_ID) {
    const status = ctx.myChatMember.new_chat_member.status;
    if (status === 'administrator') {
      await notifyAdmins(
        `\u2705 Connected to the free-month community (<code>${chat.id}</code>). I will only read who joined when \u2014 I never post or remove anyone there.`,
      );
    } else if (['left', 'kicked', 'member'].includes(status)) {
      await notifyAdmins(
        '\u26A0\uFE0F I am no longer an admin in the free-month community, so I cannot check who qualifies. Make me an admin there again.',
      );
    }
    return;
  }

  if (chat && chat.id !== env.GROUP_CHAT_ID && chat.type !== 'private') {
    const status = ctx.myChatMember.new_chat_member.status;
    if (status !== 'administrator' && status !== 'member') return;

    const title = 'title' in chat ? chat.title : 'this chat';
    const lines = [
      '\u{1F4CD} <b>I was added to a chat</b>',
      '',
      `Title: <b>${escapeHtml(title)}</b>`,
      `Type: <b>${chat.type}</b>`,
      `ID: <code>${chat.id}</code>`,
      '',
    ];

    if (chat.type === 'group') {
      lines.push(
        '\u26A0\uFE0F This is a <b>basic group</b>. I cannot remove members from it.',
        'Convert it: Group \u2192 Edit \u2192 Chat history for new members \u2192 Visible.',
        'Telegram gives it a new ID when it converts, and I will message you again.',
      );
    } else if (status !== 'administrator') {
      lines.push(
        '\u26A0\uFE0F I am only a member. Make me an <b>admin</b> who can invite',
        'users via link and remove members.',
      );
    } else if (env.groupConfigured) {
      // The paid channel is already set, so this is almost certainly the
      // community whose recent members get a free month.
      lines.push(
        '\u2705 If this is the community whose recent members get a <b>free month</b>, set this in',
        'Vercel \u2192 Settings \u2192 Environment Variables, then redeploy:',
        '',
        `<code>TRIAL_SOURCE_CHAT_ID=${chat.id}</code>`,
        '',
        '<i>Do not change GROUP_CHAT_ID \u2014 that stays your paid channel.</i>',
      );
    } else {
      lines.push(
        `\u2705 To make this the academy ${chat.type === 'channel' ? 'channel' : 'group'}, set this in Vercel`,
        '\u2192 Settings \u2192 Environment Variables, then redeploy:',
        '',
        `<code>GROUP_CHAT_ID=${chat.id}</code>`,
      );
    }

    await notifyAdmins(lines.join('\n'));
    log.info('Added to an unconfigured chat; admins notified', { chatId: chat.id, type: chat.type, status });
    return;
  }

  if (chat?.id !== env.GROUP_CHAT_ID) return;

  const status = ctx.myChatMember.new_chat_member.status;
  log.info('Bot membership in the managed group changed', { status });

  if (status === 'administrator') {
    log.info('Bot is an administrator in the group — invite links and removals are available');
  } else if (['left', 'kicked', 'member'].includes(status)) {
    log.error('Bot is no longer an administrator in the group; access management will fail');
  }
});
