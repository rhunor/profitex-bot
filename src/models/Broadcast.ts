import mongoose, { Schema, type Document, type Model, type Types } from 'mongoose';
import { BROADCAST_AUDIENCES, BROADCAST_STATUSES, type BroadcastAudience, type BroadcastStatus } from './types';

export interface IBroadcast extends Document {
  createdByTelegramId: number;
  audience: BroadcastAudience;
  /** `copy` forwards the original admin message (keeps media/formatting verbatim). */
  mode: 'copy';
  sourceChatId: number;
  sourceMessageId: number;
  preview: string;
  total: number;
  sent: number;
  failed: number;
  status: BroadcastStatus;
  startedAt?: Date;
  finishedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const broadcastSchema = new Schema<IBroadcast>(
  {
    createdByTelegramId: { type: Number, required: true },
    audience: { type: String, enum: BROADCAST_AUDIENCES, required: true },
    mode: { type: String, enum: ['copy'], default: 'copy' },
    sourceChatId: { type: Number, required: true },
    sourceMessageId: { type: Number, required: true },
    preview: { type: String, default: '' },
    total: { type: Number, default: 0 },
    sent: { type: Number, default: 0 },
    failed: { type: Number, default: 0 },
    status: { type: String, enum: BROADCAST_STATUSES, default: 'queued', index: true },
    startedAt: { type: Date },
    finishedAt: { type: Date },
  },
  { timestamps: true, collection: 'broadcasts' },
);

export const Broadcast: Model<IBroadcast> =
  (mongoose.models.Broadcast as Model<IBroadcast>) ??
  mongoose.model<IBroadcast>('Broadcast', broadcastSchema);

export interface IBroadcastTarget extends Document {
  broadcast: Types.ObjectId;
  telegramId: number;
  status: 'pending' | 'sent' | 'failed';
  attempts: number;
  error?: string;
  sentAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const broadcastTargetSchema = new Schema<IBroadcastTarget>(
  {
    broadcast: { type: Schema.Types.ObjectId, ref: 'Broadcast', required: true, index: true },
    telegramId: { type: Number, required: true },
    status: { type: String, enum: ['pending', 'sent', 'failed'], default: 'pending', index: true },
    attempts: { type: Number, default: 0 },
    error: { type: String },
    sentAt: { type: Date },
  },
  { timestamps: true, collection: 'broadcast_targets' },
);

broadcastTargetSchema.index({ broadcast: 1, telegramId: 1 }, { unique: true });
broadcastTargetSchema.index({ broadcast: 1, status: 1 });

export const BroadcastTarget: Model<IBroadcastTarget> =
  (mongoose.models.BroadcastTarget as Model<IBroadcastTarget>) ??
  mongoose.model<IBroadcastTarget>('BroadcastTarget', broadcastTargetSchema);
