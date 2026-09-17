import mongoose, { Schema, type Document, type Model, type Types } from 'mongoose';
import { INVITE_STATUSES, type InviteStatus } from './types';

export interface IInviteLink extends Document {
  user: Types.ObjectId;
  telegramId: number;
  subscription?: Types.ObjectId;
  payment?: Types.ObjectId;
  paymentReference?: string;
  inviteLink: string;
  name: string;
  memberLimit: number;
  expiresAt: Date;
  status: InviteStatus;
  usedAt?: Date;
  usedByTelegramId?: number;
  revokedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const inviteLinkSchema = new Schema<IInviteLink>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    telegramId: { type: Number, required: true, index: true },
    subscription: { type: Schema.Types.ObjectId, ref: 'Subscription' },
    payment: { type: Schema.Types.ObjectId, ref: 'Payment' },
    paymentReference: { type: String },
    inviteLink: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true },
    memberLimit: { type: Number, default: 1 },
    expiresAt: { type: Date, required: true, index: true },
    status: { type: String, enum: INVITE_STATUSES, default: 'active', index: true },
    usedAt: { type: Date },
    usedByTelegramId: { type: Number },
    revokedAt: { type: Date },
  },
  { timestamps: true, collection: 'invite_links' },
);

inviteLinkSchema.index({ telegramId: 1, status: 1 });

export const InviteLink: Model<IInviteLink> =
  (mongoose.models.InviteLink as Model<IInviteLink>) ??
  mongoose.model<IInviteLink>('InviteLink', inviteLinkSchema);
