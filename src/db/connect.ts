import mongoose from 'mongoose';
import { getEnv } from '../config/env';
import { createLogger } from '../utils/logger';

const log = createLogger('db');

type CachedConnection = {
  conn: typeof mongoose | null;
  promise: Promise<typeof mongoose> | null;
};

// Serverless invocations reuse the same Node process; caching on globalThis
// stops every cold-ish start from opening a brand new connection pool.
const globalScope = globalThis as unknown as { __profitexMongoose?: CachedConnection };
const cached: CachedConnection = (globalScope.__profitexMongoose ??= { conn: null, promise: null });

export async function connectToDatabase(): Promise<typeof mongoose> {
  if (cached.conn && mongoose.connection.readyState === 1) return cached.conn;

  if (!cached.promise) {
    const env = getEnv();
    mongoose.set('strictQuery', true);

    cached.promise = mongoose
      .connect(env.MONGODB_URI, {
        dbName: env.MONGODB_DB_NAME,
        serverSelectionTimeoutMS: 15_000,
        socketTimeoutMS: 45_000,
        maxPoolSize: 10,
        minPoolSize: 0,
        retryWrites: true,
      })
      .then((m) => {
        log.info('Connected to MongoDB', { db: m.connection.name });
        return m;
      })
      .catch((error) => {
        cached.promise = null;
        log.error('MongoDB connection failed', error);
        throw error;
      });
  }

  cached.conn = await cached.promise;
  return cached.conn;
}

export async function disconnectFromDatabase(): Promise<void> {
  if (cached.conn) {
    await mongoose.disconnect();
    cached.conn = null;
    cached.promise = null;
    log.info('Disconnected from MongoDB');
  }
}

mongoose.connection.on('disconnected', () => {
  log.warn('MongoDB connection lost');
  cached.conn = null;
  cached.promise = null;
});
