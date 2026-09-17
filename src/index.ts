import http from 'node:http';
import cron from 'node-cron';
import { getEnv, publicUrl } from './config/env';
import { createLogger } from './utils/logger';
import { connectToDatabase, disconnectFromDatabase } from './db/connect';
import { createApp } from './http/app';
import { ALLOWED_UPDATES, getBot, publishCommands } from './bot';
import { runScheduledWork } from './jobs/scheduler';

const log = createLogger('main');

async function main(): Promise<void> {
  const env = getEnv();

  log.info('Starting Profitex subscription bot', {
    mode: env.BOT_MODE,
    env: env.NODE_ENV,
    internalCron: Boolean(env.ENABLE_INTERNAL_CRON),
  });

  await connectToDatabase();

  const bot = await getBot();
  log.info(`Authenticated as @${bot.botInfo.username}`);
  await publishCommands(bot);

  const app = createApp();
  const server = http.createServer(app);

  await new Promise<void>((resolve) => server.listen(env.PORT, resolve));
  log.info(`HTTP server listening on port ${env.PORT}`);

  let cronTask: ReturnType<typeof cron.schedule> | null = null;

  if (env.ENABLE_INTERNAL_CRON) {
    if (!cron.validate(env.CRON_SCHEDULE)) {
      throw new Error(`CRON_SCHEDULE "${env.CRON_SCHEDULE}" is not a valid cron expression.`);
    }
    cronTask = cron.schedule(
      env.CRON_SCHEDULE,
      () => {
        void runScheduledWork().catch((error) => log.error('Scheduled pass failed', error));
      },
      { timezone: env.APP_TIMEZONE },
    );
    log.info(`Internal scheduler active (${env.CRON_SCHEDULE}, ${env.APP_TIMEZONE})`);
  } else {
    log.info('Internal scheduler disabled — drive /api/cron/run from an external scheduler');
  }

  if (env.BOT_MODE === 'webhook') {
    const url = publicUrl('/api/telegram');
    await bot.api.setWebhook(url, {
      allowed_updates: [...ALLOWED_UPDATES],
      secret_token: env.TELEGRAM_WEBHOOK_SECRET,
      drop_pending_updates: false,
    });
    log.info(`Webhook registered at ${url}`);
  } else {
    // Long polling cannot coexist with a webhook.
    await bot.api.deleteWebhook({ drop_pending_updates: false });
    void bot.start({
      allowed_updates: [...ALLOWED_UPDATES],
      onStart: (info) => log.info(`Long polling started for @${info.username}`),
    });
  }

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`Received ${signal}, shutting down`);

    cronTask?.stop();
    if (env.BOT_MODE === 'polling') await bot.stop().catch(() => undefined);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await disconnectFromDatabase();

    process.exit(0);
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

process.on('unhandledRejection', (reason) => {
  log.error('Unhandled promise rejection', reason);
});

process.on('uncaughtException', (error) => {
  log.error('Uncaught exception', error);
});

main().catch((error) => {
  log.error('Fatal startup error', error);
  process.exit(1);
});
