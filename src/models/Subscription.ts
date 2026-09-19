import mongoose, { Schema, type Document, type Model, type Types } from 'mongoose';
import { SUBSCRIPTION_STATUSES, type SubscriptionStatus } from './types';

export interface IPlanSnapshot {
  code: string;
  name: string;
  priceMinor: number;
  currency: string;
  durationDays: number;
}

export interface IRemindersSent {
  d7?: Date;
  d3?: Date;
  h24?: Date;
}

export interface ISubscription extends Document {
  user: Types.ObjectId;
  telegramId: number;
  plan?: Types.ObjectId;
  planSnapshot: IPlanSnapshot;
  status: SubscriptionStatus;
  startsAt: Date;
  expiresAt: Date;
  /** Reset on every renewal so the reminder set fires again for the new cycle. */
  cycleStartedAt: Date;
  remindersSent: IRemindersSent;
  removalNoticeSentAt?: Date;
  removedFromGroupAt?: Date;
  lastPaymentReference?: string;
  source: 'payment' | 'manual' | 'trial';
  /**
   * For a free month: set when the clock is restarted from the moment the
   * subscriber actually joins, so claiming early never costs them days.
   */
  trialClockStartedAt?: Date;
  renewalCount: number;
  notes?: string;
  createdAt: Date;
  updatedAt: Date;
}

const subscriptionSchema = new Schema<ISubscription>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    telegramId: { type: Number, required: true, index: true },
    plan: { type: Schema.Types.ObjectId, ref: 'Plan' },
    planSnapshot: {
      code: { type: String, required: true },
      name: { type: String, required: true },
      priceMinor: { type: Number, required: true },
      currency: { type: String, required: true, default: 'NGN' },
      durationDays: { type: Number, required: true },
    },
    status: { type: String, enum: SUBSCRIPTION_STATUSES, required: true, default: 'active', index: true },
    startsAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true, index: true },
    cycleStartedAt: { type: Date, required: true, default: () => new Date() },
    remindersSent: {
      d7: { type: Date },
      d3: { type: Date },
      h24: { type: Date },
    },
    removalNoticeSentAt: { type: Date },
    removedFromGroupAt: { type: Date },
    lastPaymentReference: { type: String },
    source: { type: String, enum: ['payment', 'manual', 'trial'], default: 'payment' },
    trialClockStartedAt: { type: Date },
    renewalCount: { type: Number, default: 0 },
    notes: { type: String },
  },
  { timestamps: true, collection: 'subscriptions' },
);

// A subscriber can only ever hold one *active* subscription; renewals extend it.
subscriptionSchema.index(
  { telegramId: 1 },
  { unique: true, partialFilterExpression: { status: 'active' }, name: 'one_active_subscription_per_user' },
);
subscriptionSchema.index({ status: 1, expiresAt: 1 });

export const Subscription: Model<ISubscription> =
  (mongoose.models.Subscription as Model<ISubscription>) ??
  mongoose.model<ISubscription>('Subscription', subscriptionSchema);
