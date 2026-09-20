/**
 * Tells existing users, from the OLD bot, to start the new one.
 *
 *   npm run notify-switch -- --old-token <old token> --new-username <name>   # preview
 *   npm run notify-switch -- --old-token <old token> --new-username <name> --send
 *
 * Why this is needed: a Telegram bot cannot message anyone who has not started
 * a chat with it. After switching bots, existing subscribers would silently
 * stop receiving expiry reminders — and be removed at expiry without warning —
 * until they press Start on the new one. The old bot can still reach them.
 *
 * Prints a preview by default; nothing is sent without --send.
 */
import { Api, GrammyError } from 'grammy';
import { connectToDatabase, disconnectFromDatabase } from '../src/db/connect';
import { Subscription, User } from '../src/models';
import { formatDate } from '../src/utils/time';
import { escapeHtml } from '../src/utils/text';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function message(firstName: string | undefined, expiresAt: Date | null, newUsername: string): string {
  const lines = [
    `\u{1F44B} Hi${firstName ? ` <b>${escapeHtml(firstName)}</b>` : ''}, we have moved to a new bot.`,
    '',
    `\u{1F449} <b>Open @${escapeHtml(newUsername)} and press START.</b>`,
    '',
    'Your access is unchanged and carries over automatically.',
  ];
  if (expiresAt) {
    lines.push(`You are covered until <b>${escapeHtml(formatDate(expiresAt))}</b>.`);
  }
  lines.push('', 'Please do this now, so your renewal reminders reach you. This old bot will stop working.');
  return lines.join('\n');
}

async function main(): Promise<void> {
  const oldToken = arg('old-token');
  const newUsername = (arg('new-username') ?? '').replace(/^@/, '');
  const send = process.argv.includes('--send');

  if (!oldToken || !newUsername) {
    console.error('\nUsage: npm run notify-switch -- --old-token <token> --new-username <name> [--send]\n');
    process.exit(1);
  }

  await connectToDatabase();
  const api = new Api(oldToken);
  const me = await api.getMe();

  const users = await User.find({ hasBlockedBot: { $ne: true } }).lean();
  const subscriptions = await Subscription.find({ status: 'active' }).lean();

  console.log(`\nSending as @${me.username} → telling people to start @${newUsername}`);
  console.log(`${users.length} user(s) on record${send ? '' : ' — PREVIEW ONLY, pass --send to deliver'}\n`);

  let sent = 0;
  let failed = 0;

  for (const user of users) {
    const subscription = subscriptions.find((s) => s.telegramId === user.telegramId);
    const body = message(user.firstName, subscription?.expiresAt ?? null, newUsername);
    const label = `${user.telegramId} ${[user.firstName, user.lastName].filter(Boolean).join(' ')}`;

    if (!send) {
      console.log(`--- ${label} ---\n${body.replace(/<[^>]+>/g, '')}\n`);
      continue;
    }

    try {
      await api.sendMessage(user.telegramId, body, { parse_mode: 'HTML' });
      sent += 1;
      console.log(`✅ ${label}`);
    } catch (error) {
      failed += 1;
      console.log(`❌ ${label}: ${error instanceof GrammyError ? error.description : String(error)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  if (send) console.log(`\nDelivered ${sent}, failed ${failed}\n`);
  await disconnectFromDatabase();
}

main().catch((error) => {
  console.error('\nFailed:', error instanceof Error ? error.message : error, '\n');
  process.exit(1);
});
