import mongoose, { Schema, type Document, type Model } from 'mongoose';

export interface IUser extends Document {
  telegramId: number;
  firstName?: string;
  lastName?: string;
  username?: string;
  languageCode?: string;
  email?: string;
  phone?: string;
  isAdmin: boolean;
  /** Set when Telegram tells us the user blocked the bot; broadcasts skip these. */
  hasBlockedBot: boolean;
  inGroup: boolean;
  joinedGroupAt?: Date;
  leftGroupAt?: Date;
  lastSeenAt: Date;
  /** Set once, when the free month is granted. Guarantees one trial per person. */
  trialClaimedAt?: Date;
  /** Last eligibility answer, cached so /start does not query Telegram every time. */
  trialCheck?: { result: string; joinedAt?: Date; checkedAt: Date };
  createdAt: Date;
  updatedAt: Date;
}

const userSchema = new Schema<IUser>(
  {
    telegramId: { type: Number, required: true, unique: true, index: true },
    firstName: { type: String, trim: true },
    lastName: { type: String, trim: true },
    username: { type: String, trim: true },
    languageCode: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true },
    phone: { type: String, trim: true },
    isAdmin: { type: Boolean, default: false },
    hasBlockedBot: { type: Boolean, default: false },
    inGroup: { type: Boolean, default: false },
    joinedGroupAt: { type: Date },
    leftGroupAt: { type: Date },
    lastSeenAt: { type: Date, default: () => new Date() },
    trialClaimedAt: { type: Date, default: null },
    trialCheck: {
      result: { type: String },
      joinedAt: { type: Date },
      checkedAt: { type: Date },
    },
  },
  { timestamps: true, collection: 'users' },
);

userSchema.index({ username: 1 });

export const User: Model<IUser> =
  (mongoose.models.User as Model<IUser>) ?? mongoose.model<IUser>('User', userSchema);
