import mongoose, { Schema, type Document, type Model } from 'mongoose';

export interface IPlan extends Document {
  code: string;
  name: string;
  description?: string;
  /** Minor units (kobo). */
  priceMinor: number;
  currency: string;
  durationDays: number;
  sortOrder: number;
  /** Optional label shown beside the plan, e.g. "Most Popular". */
  badge?: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const planSchema = new Schema<IPlan>(
  {
    code: { type: String, required: true, unique: true, trim: true, lowercase: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    priceMinor: { type: Number, required: true, min: 1 },
    currency: { type: String, required: true, default: 'NGN', uppercase: true },
    durationDays: { type: Number, required: true, min: 1 },
    sortOrder: { type: Number, default: 100 },
    badge: { type: String, trim: true, default: null },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true, collection: 'plans' },
);

planSchema.index({ isActive: 1, sortOrder: 1 });

export const Plan: Model<IPlan> =
  (mongoose.models.Plan as Model<IPlan>) ?? mongoose.model<IPlan>('Plan', planSchema);
