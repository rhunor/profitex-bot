/**
 * Prints the parsed configuration as JSON. Spawned by tests/smoke.ts from a
 * directory with no .env files, so only the environment passed to it applies.
 */
import { getEnv } from '../../src/config/env';

try {
  const env = getEnv();
  process.stdout.write(
    JSON.stringify({
      ok: true,
      publicUrl: env.PUBLIC_URL ?? null,
      cronSecret: env.CRON_SECRET ?? null,
      webhookSecret: env.TELEGRAM_WEBHOOK_SECRET ?? null,
      supportUsername: env.SUPPORT_USERNAME ?? null,
      currency: env.CURRENCY,
      port: env.PORT,
      groupName: env.GROUP_NAME,
      adminCount: env.adminIds.size,
      paystackEnabled: env.paystackEnabled,
      flutterwaveEnabled: env.flutterwaveEnabled,
      botMode: env.BOT_MODE,
      internalCron: env.ENABLE_INTERNAL_CRON ?? null,
      onVercel: env.onVercel,
      groupConfigured: env.groupConfigured,
      groupChatId: env.GROUP_CHAT_ID,
      communityType: env.COMMUNITY_TYPE,
    }),
  );
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, message: error instanceof Error ? error.message : String(error) }));
}
