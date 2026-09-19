import mongoose, { Schema, type Document, type Model } from 'mongoose';

/**
 * Small key/value store for state the app must keep between serverless
 * invocations — currently the Telegram full-API session, so the bot signs in
 * once rather than on every cold start (Telegram rate-limits repeated sign-ins).
 */
export interface IAppSetting extends Document {
  key: string;
  value: string;
  updatedAt: Date;
}

const appSettingSchema = new Schema<IAppSetting>(
  {
    key: { type: String, required: true, unique: true, index: true },
    value: { type: String, required: true },
  },
  { timestamps: true, collection: 'app_settings' },
);

export const AppSetting: Model<IAppSetting> =
  (mongoose.models.AppSetting as Model<IAppSetting>) ?? mongoose.model<IAppSetting>('AppSetting', appSettingSchema);

export async function readSetting(key: string): Promise<string | null> {
  const doc = await AppSetting.findOne({ key }).lean();
  return doc?.value ?? null;
}

export async function writeSetting(key: string, value: string): Promise<void> {
  await AppSetting.updateOne({ key }, { $set: { value } }, { upsert: true });
}
