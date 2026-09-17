import type { Types } from 'mongoose';
import { getEnv } from '../config/env';
import { createLogger } from '../utils/logger';
import { addMinutes } from '../utils/time';
import { randomToken } from '../utils/reference';
import { displayName } from '../utils/text';
import { InviteLink, recordActivity, type IInviteLink, type IPayment, type ISubscription, type IUser } from '../models';
import { createSingleUseInviteLink, revokeInviteLink } from './telegram';

const log = createLogger('invites');

/**
 * Invalidates every outstanding link for a subscriber, on Telegram's side as
 * well as ours, so only the newest link can ever admit anyone.
 */
export async function revokeActiveLinksFor(telegramId: number): Promise<number> {
  const links = await InviteLink.find({ telegramId, status: 'active' });
  let revoked = 0;

  for (const link of links) {
    await revokeInviteLink(link.inviteLink);
    link.status = 'revoked';
    link.revokedAt = new Date();
    await link.save();
    revoked += 1;
  }

  if (revoked > 0) {
    recordActivity({ action: 'invite.revoked', telegramId, message: `Revoked ${revoked} outstanding link(s)` });
  }

  return revoked;
}

export interface IssueInviteInput {
  user: IUser;
  subscription: ISubscription;
  payment?: IPayment | null;
}

/**
 * Issues a fresh single-use invite link tied to one subscriber.
 *
 * The link admits exactly one person and expires after
 * INVITE_LINK_TTL_MINUTES (never past the subscription's own end date), so a
 * link copied out of a chat history is worthless.
 */
export async function issueInviteLink(input: IssueInviteInput): Promise<IInviteLink> {
  const env = getEnv();
  const { user, subscription, payment } = input;

  await revokeActiveLinksFor(user.telegramId);

  const ttlExpiry = addMinutes(new Date(), env.INVITE_LINK_TTL_MINUTES);
  const expiresAt = ttlExpiry > subscription.expiresAt ? subscription.expiresAt : ttlExpiry;

  const label = `${displayName({
    firstName: user.firstName,
    lastName: user.lastName,
    username: user.username,
    telegramId: user.telegramId,
  })} ${randomToken(4)}`.slice(0, 32);

  const created = await createSingleUseInviteLink(label, expiresAt);

  const record = await InviteLink.create({
    user: user._id as Types.ObjectId,
    telegramId: user.telegramId,
    subscription: subscription._id as Types.ObjectId,
    payment: (payment?._id as Types.ObjectId) ?? undefined,
    paymentReference: payment?.reference,
    inviteLink: created.invite_link,
    name: label,
    memberLimit: 1,
    expiresAt,
    status: 'active',
  });

  recordActivity({
    action: 'invite.issued',
    telegramId: user.telegramId,
    message: `Link valid until ${expiresAt.toISOString()}`,
    meta: { reference: payment?.reference },
  });

  log.info('Issued invite link', { telegramId: user.telegramId, expiresAt });
  return record;
}

/** Returns a still-valid link for this subscriber, or null if one must be minted. */
export async function findUsableLink(telegramId: number): Promise<IInviteLink | null> {
  return InviteLink.findOne({
    telegramId,
    status: 'active',
    expiresAt: { $gt: new Date() },
  }).sort({ createdAt: -1 });
}

/**
 * Records that a link was consumed. Called from the chat_member handler, which
 * is how every member in the group gets tied back to a real payment.
 */
export async function markLinkUsed(inviteLinkUrl: string, telegramId: number): Promise<IInviteLink | null> {
  const link = await InviteLink.findOneAndUpdate(
    { inviteLink: inviteLinkUrl, status: 'active' },
    { $set: { status: 'used', usedAt: new Date(), usedByTelegramId: telegramId } },
    { returnDocument: 'after' },
  );

  if (link) {
    recordActivity({ action: 'invite.used', telegramId, message: 'Joined via issued invite link' });
  }

  return link;
}

/** Sweeps links whose window closed without being used. */
export async function expireStaleLinks(): Promise<number> {
  const result = await InviteLink.updateMany(
    { status: 'active', expiresAt: { $lte: new Date() } },
    { $set: { status: 'expired' } },
  );
  return result.modifiedCount ?? 0;
}
