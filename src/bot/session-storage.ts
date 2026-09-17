import type { StorageAdapter } from 'grammy';
import { BotSession } from '../models';
import { createLogger } from '../utils/logger';
import type { SessionData } from './context';

const log = createLogger('session');

/**
 * Sessions live in MongoDB rather than memory: on a serverless host every
 * update can land in a fresh process, and an in-memory session would drop a
 * half-finished admin flow between two messages.
 */
export class MongoSessionStorage implements StorageAdapter<SessionData> {
  async read(key: string): Promise<SessionData | undefined> {
    try {
      const doc = await BotSession.findOne({ key }).lean();
      return (doc?.value as SessionData) ?? undefined;
    } catch (error) {
      log.error('Session read failed', error);
      return undefined;
    }
  }

  async write(key: string, value: SessionData): Promise<void> {
    try {
      await BotSession.updateOne({ key }, { $set: { value } }, { upsert: true });
    } catch (error) {
      log.error('Session write failed', error);
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await BotSession.deleteOne({ key });
    } catch (error) {
      log.error('Session delete failed', error);
    }
  }
}
