import mongoose, { Schema, type Document, type Model } from 'mongoose';

/**
 * grammY session storage. Persisting sessions in Mongo (rather than memory)
 * is what makes multi-step admin flows survive serverless cold starts.
 */
export interface IBotSession extends Document {
  key: string;
  value: unknown;
  updatedAt: Date;
}

const botSessionSchema = new Schema<IBotSession>(
  {
    key: { type: String, required: true, unique: true, index: true },
    value: { type: Schema.Types.Mixed },
  },
  { timestamps: true, collection: 'bot_sessions' },
);

export const BotSession: Model<IBotSession> =
  (mongoose.models.BotSession as Model<IBotSession>) ??
  mongoose.model<IBotSession>('BotSession', botSessionSchema);
