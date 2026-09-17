/**
 * Registers (or removes) the Telegram webhook for this deployment.
 *
 *   npm run set-webhook      # point Telegram at PUBLIC_URL/api/telegram
 *   npm run delete-webhook   # remove it (needed before long polling)
 */
import { Api } from 'grammy';
import { getEnv, publicUrl } from '../src/config/env';
import { ALLOWED_UPDATES } from '../src/bot';
import { createLogger } from '../src/utils/logger';

const log = createLogger('set-webhook');

async function main(): Promise<void> {
  const env = getEnv();
  const api = new Api(env.BOT_TOKEN);
  const remove = process.argv.includes('--delete');

  const me = await api.getMe();
  log.info(`Authenticated as @${me.username}`);

  if (remove) {
    await api.deleteWebhook({ drop_pending_updates: false });
    log.info('Webhook removed. The bot can now run with long polling.');
    return;
  }

  if (!env.PUBLIC_URL) {
    throw new Error('PUBLIC_URL must be set before registering a webhook.');
  }
  if (!env.TELEGRAM_WEBHOOK_SECRET) {
    log.warn('TELEGRAM_WEBHOOK_SECRET is not set. Anyone who guesses the URL could post fake updates.');
  }

  const url = publicUrl('/api/telegram');

  await api.setWebhook(url, {
    allowed_updates: [...ALLOWED_UPDATES],
    secret_token: env.TELEGRAM_WEBHOOK_SECRET,
    drop_pending_updates: false,
    max_connections: 40,
  });

  const info = await api.getWebhookInfo();
  console.log('\nWebhook registered:');
  console.log(`  URL................ ${info.url}`);
  console.log(`  Pending updates.... ${info.pending_update_count}`);
  console.log(`  Allowed updates.... ${(info.allowed_updates ?? []).join(', ') || 'all'}`);
  console.log(`  Custom certificate. ${info.has_custom_certificate}`);
  if (info.last_error_message) {
    console.log(`  ⚠️ Last error....... ${info.last_error_message}`);
  }
  console.log('');
}

main().catch((error) => {
  log.error('Failed', error);
  process.exit(1);
});
