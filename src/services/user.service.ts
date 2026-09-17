import type { Types } from 'mongoose';
import { getEnv } from '../config/env';
import { User, type IUser } from '../models';

export interface TelegramUserLike {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

/** Creates or refreshes the local record for a Telegram user. */
export async function upsertUser(from: TelegramUserLike): Promise<IUser> {
  const env = getEnv();
  const user = await User.findOneAndUpdate(
    { telegramId: from.id },
    {
      $set: {
        firstName: from.first_name,
        lastName: from.last_name,
        username: from.username,
        languageCode: from.language_code,
        lastSeenAt: new Date(),
        hasBlockedBot: false,
      },
      $setOnInsert: { telegramId: from.id },
    },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
  );

  // Environment-listed admins are always admins, regardless of DB state.
  if (env.adminIds.has(from.id) && !user.isAdmin) {
    user.isAdmin = true;
    await user.save();
  }

  return user;
}

export async function findUserByTelegramId(telegramId: number): Promise<IUser | null> {
  return User.findOne({ telegramId });
}

/**
 * Admin lookup by numeric id, @username or name fragment.
 * Returns at most `limit` matches, most recently seen first.
 */
export async function searchUsers(query: string, limit = 10): Promise<IUser[]> {
  const trimmed = query.trim().replace(/^@/, '');
  if (!trimmed) return [];

  const asNumber = Number(trimmed);
  if (Number.isFinite(asNumber) && /^\d+$/.test(trimmed)) {
    const byId = await User.findOne({ telegramId: asNumber });
    if (byId) return [byId];
  }

  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(escaped, 'i');
  return User.find({ $or: [{ username: regex }, { firstName: regex }, { lastName: regex }] })
    .sort({ lastSeenAt: -1 })
    .limit(limit);
}

export async function markUnreachable(telegramId: number): Promise<void> {
  await User.updateOne({ telegramId }, { $set: { hasBlockedBot: true } });
}

export async function setGroupMembership(telegramId: number, inGroup: boolean): Promise<void> {
  await User.updateOne(
    { telegramId },
    { $set: inGroup ? { inGroup: true, joinedGroupAt: new Date() } : { inGroup: false, leftGroupAt: new Date() } },
  );
}

export async function isAdminUser(telegramId: number): Promise<boolean> {
  if (getEnv().adminIds.has(telegramId)) return true;
  const user = await User.findOne({ telegramId }).select('isAdmin').lean();
  return Boolean(user?.isAdmin);
}

export async function listAdminIds(): Promise<number[]> {
  const env = getEnv();
  const dbAdmins = await User.find({ isAdmin: true }).select('telegramId').lean();
  return Array.from(new Set([...env.adminIds, ...dbAdmins.map((a) => a.telegramId)]));
}

export function userObjectId(user: IUser): Types.ObjectId {
  return user._id as Types.ObjectId;
}
