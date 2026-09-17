/**
 * Pre-flight check. Run this before going live and any time something breaks.
 *
 *   npm run doctor
 *
 * It verifies the environment, the database, the bot's rights in the group,
 * both payment gateways, the webhook registration and the plan catalogue.
 */
import { Api, GrammyError } from 'grammy';
import { getEnv } from '../src/config/env';
import { connectToDatabase, disconnectFromDatabase } from '../src/db/connect';
import { Plan, Subscription, User } from '../src/models';
import { formatMoney } from '../src/utils/money';

type Status = 'pass' | 'warn' | 'fail';

const results: Array<{ status: Status; label: string; detail: string }> = [];

function record(status: Status, label: string, detail: string): void {
  results.push({ status, label, detail });
  const icon = status === 'pass' ? '✅' : status === 'warn' ? '⚠️ ' : '❌';
  console.log(`${icon} ${label}\n   ${detail}\n`);
}

async function checkEnvironment(): Promise<ReturnType<typeof getEnv> | null> {
  try {
    const env = getEnv();
    record('pass', 'Environment', `Loaded. Mode=${env.BOT_MODE}, currency=${env.CURRENCY}, tz=${env.APP_TIMEZONE}`);

    if (env.adminIds.size === 0) {
      record('fail', 'Admins', 'ADMIN_TELEGRAM_IDS is empty — nobody can run admin commands.');
    } else {
      record('pass', 'Admins', `${env.adminIds.size} admin id(s) configured: ${[...env.adminIds].join(', ')}`);
    }

    if (env.BOT_MODE === 'webhook' && !env.TELEGRAM_WEBHOOK_SECRET) {
      record('warn', 'Webhook secret', 'TELEGRAM_WEBHOOK_SECRET is not set. Set one before going live.');
    }

    if (!env.CRON_SECRET) {
      record('warn', 'Cron secret', 'CRON_SECRET is not set — /api/cron/run is unprotected in non-production.');
    }

    if (!env.PUBLIC_URL) {
      record('warn', 'Public URL', 'PUBLIC_URL is not set. Payments and webhooks need it.');
    }

    return env;
  } catch (error) {
    record('fail', 'Environment', error instanceof Error ? error.message : String(error));
    return null;
  }
}

async function checkDatabase(): Promise<boolean> {
  try {
    const connection = await connectToDatabase();
    const [users, plans, active] = await Promise.all([
      User.countDocuments({}),
      Plan.countDocuments({ isActive: true }),
      Subscription.countDocuments({ status: 'active' }),
    ]);
    record(
      'pass',
      'MongoDB',
      `Connected to "${connection.connection.name}". ${users} user(s), ${plans} active plan(s), ${active} active subscription(s).`,
    );

    if (plans === 0) {
      record('warn', 'Plans', 'No active plans. Run `npm run seed`, or add one from /admin → Plans.');
    } else {
      const list = await Plan.find({ isActive: true }).sort({ sortOrder: 1 }).lean();
      record(
        'pass',
        'Plan catalogue',
        list.map((p) => `${p.name} = ${formatMoney(p.priceMinor, p.currency)} / ${p.durationDays}d`).join('; '),
      );
    }
    return true;
  } catch (error) {
    record('fail', 'MongoDB', error instanceof Error ? error.message : String(error));
    return false;
  }
}

async function checkTelegram(env: ReturnType<typeof getEnv>): Promise<void> {
  const api = new Api(env.BOT_TOKEN);

  let botId: number;
  try {
    const me = await api.getMe();
    botId = me.id;
    record('pass', 'Bot token', `Authenticated as @${me.username} (id ${me.id})`);
  } catch (error) {
    record('fail', 'Bot token', error instanceof Error ? error.message : String(error));
    return;
  }

  if (!env.groupConfigured) {
    record('fail', 'Group', 'GROUP_CHAT_ID is not set. Add the bot to the group as an admin; it will message the admins the id.');
    return;
  }

  try {
    const chat = await api.getChat(env.GROUP_CHAT_ID);
    const title = 'title' in chat ? chat.title : '(untitled)';

    if (chat.type !== 'supergroup' && chat.type !== 'channel') {
      record(
        'fail',
        'Group type',
        `"${title}" is a ${chat.type}. Removing members needs a supergroup — enable chat history for new members, or convert the group.`,
      );
    } else {
      record('pass', 'Group', `Connected to "${title}" (${chat.type}, id ${env.GROUP_CHAT_ID})`);
    }
  } catch (error) {
    const message = error instanceof GrammyError ? error.description : String(error);
    record('fail', 'Group', `Could not read GROUP_CHAT_ID ${env.GROUP_CHAT_ID}: ${message}`);
    return;
  }

  try {
    const member = await api.getChatMember(env.GROUP_CHAT_ID, botId);

    if (member.status !== 'administrator') {
      record('fail', 'Bot rights', `The bot is "${member.status}" in the group. It must be an administrator.`);
      return;
    }

    const missing: string[] = [];
    if (!member.can_invite_users) missing.push('Invite Users via Link');
    if (!member.can_restrict_members) missing.push('Ban Users');

    if (missing.length > 0) {
      record('fail', 'Bot rights', `Administrator, but missing: ${missing.join(', ')}.`);
    } else {
      record('pass', 'Bot rights', 'Administrator with invite-link and ban permissions.');
    }
  } catch (error) {
    record('fail', 'Bot rights', error instanceof Error ? error.message : String(error));
  }

  try {
    const info = await api.getWebhookInfo();
    if (env.BOT_MODE === 'webhook') {
      if (!info.url) {
        record('fail', 'Webhook', 'No webhook registered. Run `npm run set-webhook`.');
      } else {
        const allowed = info.allowed_updates ?? [];
        const missingChatMember = allowed.length > 0 && !allowed.includes('chat_member');
        record(
          missingChatMember ? 'warn' : 'pass',
          'Webhook',
          `${info.url} — ${info.pending_update_count} pending${missingChatMember ? '. "chat_member" is NOT in allowed_updates: join detection will not work. Re-run `npm run set-webhook`.' : ''}${info.last_error_message ? `. Last error: ${info.last_error_message}` : ''}`,
        );
      }
    } else if (info.url) {
      record('warn', 'Webhook', `A webhook is still registered (${info.url}). Long polling will not receive updates until it is removed.`);
    } else {
      record('pass', 'Webhook', 'No webhook registered — correct for long polling.');
    }
  } catch (error) {
    record('warn', 'Webhook', error instanceof Error ? error.message : String(error));
  }
}

async function checkPaystack(env: ReturnType<typeof getEnv>): Promise<void> {
  if (!env.PAYSTACK_SECRET_KEY) {
    record('warn', 'Paystack', 'Not configured (PAYSTACK_SECRET_KEY is empty).');
    return;
  }

  const live = env.PAYSTACK_SECRET_KEY.startsWith('sk_live_');
  try {
    const response = await fetch('https://api.paystack.co/transaction?perPage=1', {
      headers: { Authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 401) {
      record('fail', 'Paystack', 'The secret key was rejected (401). Check PAYSTACK_SECRET_KEY.');
      return;
    }
    if (!response.ok) {
      record('warn', 'Paystack', `Unexpected response ${response.status} while checking the key.`);
      return;
    }
    record('pass', 'Paystack', `Key accepted (${live ? 'LIVE' : 'test'} mode).`);
  } catch (error) {
    record('fail', 'Paystack', error instanceof Error ? error.message : String(error));
  }
}

async function checkFlutterwave(env: ReturnType<typeof getEnv>): Promise<void> {
  if (!env.FLUTTERWAVE_SECRET_KEY) {
    record('warn', 'Flutterwave', 'Not configured (FLUTTERWAVE_SECRET_KEY is empty).');
    return;
  }

  const live = !env.FLUTTERWAVE_SECRET_KEY.includes('TEST');
  try {
    const response = await fetch(
      'https://api.flutterwave.com/v3/transactions/verify_by_reference?tx_ref=profitex-doctor-ping',
      {
        headers: { Authorization: `Bearer ${env.FLUTTERWAVE_SECRET_KEY}` },
        signal: AbortSignal.timeout(15_000),
      },
    );

    if (response.status === 401) {
      record('fail', 'Flutterwave', 'The secret key was rejected (401). Check FLUTTERWAVE_SECRET_KEY.');
      return;
    }
    // 400/404 here means "no such transaction", which proves the key works.
    record('pass', 'Flutterwave', `Key accepted (${live ? 'LIVE' : 'test'} mode).`);
  } catch (error) {
    record('fail', 'Flutterwave', error instanceof Error ? error.message : String(error));
  }

  if (!env.FLUTTERWAVE_SECRET_HASH) {
    record(
      'fail',
      'Flutterwave webhook',
      'FLUTTERWAVE_SECRET_HASH is empty, so Flutterwave webhooks will be rejected. Set the same value here and on the Flutterwave dashboard.',
    );
  } else {
    record('pass', 'Flutterwave webhook', 'Secret hash configured.');
  }
}

async function checkPublicUrl(env: ReturnType<typeof getEnv>): Promise<void> {
  if (!env.PUBLIC_URL) return;
  try {
    const response = await fetch(new URL('/health', env.PUBLIC_URL).toString(), {
      signal: AbortSignal.timeout(15_000),
    });
    if (response.ok) {
      record('pass', 'Public URL', `${env.PUBLIC_URL} is reachable.`);
    } else {
      record('warn', 'Public URL', `${env.PUBLIC_URL}/health returned ${response.status}. Is the deployment live?`);
    }
  } catch (error) {
    record('warn', 'Public URL', `Could not reach ${env.PUBLIC_URL}: ${error instanceof Error ? error.message : error}`);
  }
}

async function main(): Promise<void> {
  console.log('\n\u{1F50E} Profitex bot — pre-flight check\n');

  const env = await checkEnvironment();
  if (!env) {
    process.exit(1);
  }

  await checkDatabase();
  await checkTelegram(env);
  await checkPaystack(env);
  // await checkFlutterwave(env); // FLUTTERWAVE-DISABLED
  await checkPublicUrl(env);

  if (!env.paystackEnabled && !env.flutterwaveEnabled) {
    record(
      'fail',
      'Payments',
      'Paystack is not configured, so nobody can subscribe. Set PAYSTACK_SECRET_KEY.',
    );
  }

  const failures = results.filter((r) => r.status === 'fail');
  const warnings = results.filter((r) => r.status === 'warn');

  console.log('─'.repeat(60));
  console.log(`${results.length - failures.length - warnings.length} passed, ${warnings.length} warning(s), ${failures.length} failure(s)\n`);

  if (failures.length > 0) {
    console.log('Fix the ❌ items before going live:\n');
    for (const failure of failures) console.log(`  • ${failure.label}: ${failure.detail}`);
    console.log('');
  }

  await disconnectFromDatabase();
  process.exit(failures.length > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error('Doctor crashed:', error);
  process.exit(1);
});
