/**
 * Sets the bot's public profile and command list.
 *
 *   npm run setup-bot
 *
 * This is the scripted equivalent of BotFather's /setdescription,
 * /setabouttext and /setcommands. Edit the copy below and re-run to change it —
 * it takes effect immediately and overwrites whatever was there before.
 *
 * Worth running even if you set the text in BotFather by hand, because the
 * command list is otherwise only published when the bot boots as a long-lived
 * process. A serverless deployment never boots, so nothing would publish it.
 *
 * Needs BOT_TOKEN only. ADMIN_TELEGRAM_IDS is used if present.
 */
import path from 'node:path';
import dotenv from 'dotenv';
import { Api, GrammyError } from 'grammy';

for (const file of ['.env.local', '.env']) {
  dotenv.config({ path: path.resolve(process.cwd(), file) });
}

/** "channel" or "group" — keep in step with COMMUNITY_TYPE in the environment. */
const COMMUNITY = process.env.COMMUNITY_TYPE === 'group' ? 'group' : 'channel';

/** Shown on the bot's profile page. Hard limit: 120 characters. */
const SHORT_DESCRIPTION =
  `Official subscription bot for Profitable Forex Trading Academy. Pay, join the ${COMMUNITY}, and manage your access.`;

/** Shown on the empty chat screen, before the user presses Start. Limit: 512. */
const DESCRIPTION = [
  'Welcome to Profitable Forex Trading Academy.',
  '',
  `This bot handles your access to our private signals and mentorship ${COMMUNITY}.`,
  '',
  // FLUTTERWAVE-DISABLED: restore to 'with Paystack or Flutterwave'
  '• Choose a plan and pay securely with Paystack',
  '• Get your own private, single-use invite link the moment payment clears',
  '• Check when your access expires and renew in two taps',
  '',
  'Press START to see the plans.',
].join('\n');

const PUBLIC_COMMANDS = [
  { command: 'start', description: 'Open the main menu' },
  { command: 'plans', description: 'See subscription plans' },
  { command: 'status', description: 'Check your subscription' },
  { command: 'link', description: 'Get your invite link' },
  { command: 'renew', description: 'Renew your subscription' },
  { command: 'help', description: 'Help and support' },
];

const ADMIN_COMMANDS = [
  { command: 'start', description: 'Open the main menu' },
  { command: 'admin', description: 'Admin dashboard' },
  { command: 'stats', description: 'Overview' },
  { command: 'members', description: 'Active subscribers' },
  { command: 'payments', description: 'Payment history' },
  { command: 'find', description: 'Look up a member' },
  { command: 'grant', description: 'Grant or extend access' },
  { command: 'revoke', description: 'Revoke access' },
  { command: 'dm', description: 'Message one member' },
  { command: 'post', description: `Post to the ${COMMUNITY}` },
  { command: 'broadcast', description: 'Message many members' },
  { command: 'cron', description: 'Run the maintenance pass' },
];

function assertLength(label: string, value: string, max: number): void {
  if (value.length > max) {
    throw new Error(`${label} is ${value.length} characters; Telegram allows ${max}.`);
  }
  console.log(`  ${label}: ${value.length}/${max} characters`);
}

async function main(): Promise<void> {
  const token = process.env.BOT_TOKEN;
  if (!token) {
    console.error('\nBOT_TOKEN is not set. Put it in .env.local first.\n');
    process.exit(1);
  }

  console.log('\nChecking copy length');
  assertLength('Short description', SHORT_DESCRIPTION, 120);
  assertLength('Description', DESCRIPTION, 512);

  const api = new Api(token);
  const me = await api.getMe();
  console.log(`\nAuthenticated as @${me.username} (id ${me.id})\n`);

  await api.setMyShortDescription(SHORT_DESCRIPTION);
  console.log('✅ Short description set (shown on the profile page)');

  await api.setMyDescription(DESCRIPTION);
  console.log('✅ Description set (shown before a new user presses Start)');

  await api.setMyCommands(PUBLIC_COMMANDS, { scope: { type: 'all_private_chats' } });
  console.log(`✅ ${PUBLIC_COMMANDS.length} public commands published`);

  const adminIds = (process.env.ADMIN_TELEGRAM_IDS ?? '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);

  if (adminIds.length === 0) {
    console.log('ℹ️  ADMIN_TELEGRAM_IDS is empty, so admin commands were not published.');
    console.log('   Set it and re-run to give admins their extra menu.');
  } else {
    for (const adminId of adminIds) {
      try {
        await api.setMyCommands(ADMIN_COMMANDS, { scope: { type: 'chat', chat_id: adminId } });
        console.log(`✅ Admin commands published for ${adminId}`);
      } catch (error) {
        const reason = error instanceof GrammyError ? error.description : String(error);
        // Telegram refuses a chat-scoped command list until that person has
        // opened a chat with the bot at least once.
        console.log(`⚠️  Could not publish admin commands for ${adminId}: ${reason}`);
        console.log('   Ask them to press Start in the bot, then re-run this.');
      }
    }
  }

  console.log('\nWhat is set now');
  console.log('─'.repeat(58));
  console.log((await api.getMyShortDescription()).short_description);
  console.log('─'.repeat(58));
  console.log((await api.getMyDescription()).description);
  console.log('─'.repeat(58));
  console.log(`\nStill to do by hand in @BotFather: /setuserpic (the Profitex logo).\n`);
}

main().catch((error) => {
  console.error('\nFailed:', error instanceof Error ? error.message : error, '\n');
  process.exit(1);
});
