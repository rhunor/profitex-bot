import mongoose, { Schema, type Document, type Model } from 'mongoose';

export type ActivityAction =
  | 'payment.initiated'
  | 'payment.verified'
  | 'payment.failed'
  | 'subscription.activated'
  | 'subscription.renewed'
  | 'subscription.expired'
  | 'subscription.revoked'
  | 'subscription.granted'
  | 'invite.issued'
  | 'invite.used'
  | 'invite.revoked'
  | 'member.removed'
  | 'member.joined'
  | 'member.unauthorised'
  | 'reminder.sent'
  | 'broadcast.created'
  | 'broadcast.finished'
  | 'admin.dm'
  | 'admin.post'
  | 'error';

export interface IActivityLog extends Document {
  action: ActivityAction;
  telegramId?: number;
  actorTelegramId?: number;
  message?: string;
  meta?: unknown;
  createdAt: Date;
}

const activityLogSchema = new Schema<IActivityLog>(
  {
    action: { type: String, required: true, index: true },
    telegramId: { type: Number, index: true },
    actorTelegramId: { type: Number },
    message: { type: String },
    meta: { type: Schema.Types.Mixed },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'activity_logs' },
);

activityLogSchema.index({ createdAt: -1 });

export const ActivityLog: Model<IActivityLog> =
  (mongoose.models.ActivityLog as Model<IActivityLog>) ??
  mongoose.model<IActivityLog>('ActivityLog', activityLogSchema);

/** Fire-and-forget audit trail; never allowed to break the calling flow. */
export function recordActivity(entry: {
  action: ActivityAction;
  telegramId?: number;
  actorTelegramId?: number;
  message?: string;
  meta?: unknown;
}): void {
  void ActivityLog.create(entry).catch(() => undefined);
}
