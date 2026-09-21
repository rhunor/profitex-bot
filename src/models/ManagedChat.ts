import mongoose, { Schema, type Document, type Model } from 'mongoose';

/**
 * Every chat the bot has been added to.
 *
 * The Bot API offers no way to list the chats a bot belongs to, so the bot
 * records them itself as it is added, promoted, demoted or removed. This is
 * what lets an admin choose where to post.
 */
export interface IManagedChat extends Document {
  chatId: number;
  title: string;
  type: 'group' | 'supergroup' | 'channel';
  /** The bot's own status in the chat. */
  botStatus: string;
  /** The bot may send messages there right now. */
  canPost: boolean;
  /** Set for the paid channel and the free-month source, so they are labelled. */
  role?: 'paid' | 'trial-source';
  lastCheckedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const managedChatSchema = new Schema<IManagedChat>(
  {
    chatId: { type: Number, required: true, unique: true, index: true },
    title: { type: String, required: true },
    type: { type: String, enum: ['group', 'supergroup', 'channel'], required: true },
    botStatus: { type: String, required: true },
    canPost: { type: Boolean, default: false },
    role: { type: String, enum: ['paid', 'trial-source'], default: null },
    lastCheckedAt: { type: Date, default: () => new Date() },
  },
  { timestamps: true, collection: 'managed_chats' },
);

export const ManagedChat: Model<IManagedChat> =
  (mongoose.models.ManagedChat as Model<IManagedChat>) ??
  mongoose.model<IManagedChat>('ManagedChat', managedChatSchema);
