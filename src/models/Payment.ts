import mongoose, { Schema, type Document, type Model, type Types } from 'mongoose';
import { GATEWAYS, PAYMENT_STATUSES, type Gateway, type PaymentStatus } from './types';

export interface IPayment extends Document {
  /** Our own reference, generated before the subscriber leaves for the gateway. */
  reference: string;
  gateway: Gateway;
  user: Types.ObjectId;
  telegramId: number;
  plan?: Types.ObjectId;
  planCode: string;
  planName: string;
  /** What we expect to be paid, in minor units. */
  amountMinor: number;
  currency: string;
  email: string;
  status: PaymentStatus;
  checkoutUrl?: string;
  /** The gateway's own id/reference, captured at verification. */
  gatewayReference?: string;
  paidAmountMinor?: number;
  paidCurrency?: string;
  paidAt?: Date;
  channel?: string;
  /** Set once the subscription + invite link have actually been produced. */
  fulfilledAt?: Date;
  /** Short-lived lock so two webhooks can never fulfil the same payment twice. */
  fulfilmentLock?: Date;
  subscription?: Types.ObjectId;
  failureReason?: string;
  verificationPayload?: unknown;
  createdAt: Date;
  updatedAt: Date;
}

const paymentSchema = new Schema<IPayment>(
  {
    reference: { type: String, required: true, unique: true, index: true },
    gateway: { type: String, enum: GATEWAYS, required: true },
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    telegramId: { type: Number, required: true, index: true },
    plan: { type: Schema.Types.ObjectId, ref: 'Plan' },
    planCode: { type: String, required: true },
    planName: { type: String, required: true },
    amountMinor: { type: Number, required: true },
    currency: { type: String, required: true, default: 'NGN', uppercase: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    status: { type: String, enum: PAYMENT_STATUSES, required: true, default: 'pending', index: true },
    checkoutUrl: { type: String },
    gatewayReference: { type: String, index: true },
    paidAmountMinor: { type: Number },
    paidCurrency: { type: String },
    paidAt: { type: Date },
    channel: { type: String },
    fulfilledAt: { type: Date, default: null },
    fulfilmentLock: { type: Date, default: null },
    subscription: { type: Schema.Types.ObjectId, ref: 'Subscription' },
    failureReason: { type: String },
    verificationPayload: { type: Schema.Types.Mixed },
  },
  { timestamps: true, collection: 'payments' },
);

paymentSchema.index({ createdAt: -1 });
paymentSchema.index({ status: 1, fulfilledAt: 1 });

export const Payment: Model<IPayment> =
  (mongoose.models.Payment as Model<IPayment>) ?? mongoose.model<IPayment>('Payment', paymentSchema);
