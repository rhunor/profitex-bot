/**
 * Prints the numeric id of any group the bot is in.
 *
 *   npx tsx scripts/find-group-id.ts
 *
 * Add the bot to your group as an administrator, then send any message in the
 * group (or just promote the bot). The id appears here. Copy it into
 * GROUP_CHAT_ID and stop this script with Ctrl+C.
 *
 * Needs BOT_TOKEN only — no database, no other configuration.
 */
import path from 'node:path';
import dotenv from 'dotenv';
import { Bot } from 'grammy';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const token = process.env.BOT_TOKEN;
if (!token) {
  console.error('\nBOT_TOKEN is not set. Put it in .env first.\n');
  process.exit(1);
}

const seen = new Set<number>();

function report(chat: { id: number; type: string; title?: string }): void {
  if (seen.has(chat.id)) return;
  seen.add(chat.id);

  console.log('\n─'.repeat(50));
  console.log(`  Title : ${chat.title ?? '(private chat)'}`);
  console.log(`  Type  : ${chat.type}`);
  console.log(`  ID    : ${chat.id}`);
  console.log('─'.repeat(50));

  if (chat.type === 'group') {
    console.log('\n  ⚠️  This is a basic group, not a supergroup.');
    console.log('     Removing members needs a supergroup. Telegram converts a');
    console.log('     group automatically when you set a public link or change');
    console.log('     "Chat history for new members" — do that, then re-run this.');
    console.log('     The id changes when it converts.\n');
  } else if (chat.type === 'supergroup') {
    console.log(`\n  ✅ Put this in your .env:\n\n     GROUP_CHAT_ID=${chat.id}\n`);
  }
}

async function main(): Promise<void> {
  const bot = new Bot(token!);
  await bot.init();

  console.log(`\nListening as @${bot.botInfo.username}.`);
  console.log('Add the bot to your group as an admin, then send a message there.');
  console.log('Press Ctrl+C when you have the id.\n');

  bot.on('message', (ctx) => {
    if (ctx.chat.type !== 'private') report(ctx.chat);
  });
  bot.on('my_chat_member', (ctx) => {
    if (ctx.chat.type !== 'private') report(ctx.chat);
  });
  bot.on('chat_member', (ctx) => {
    if (ctx.chat.type !== 'private') report(ctx.chat);
  });

  await bot.api.deleteWebhook({ drop_pending_updates: false });
  await bot.start({ allowed_updates: ['message', 'my_chat_member', 'chat_member'] });
}

main().catch((error) => {
  console.error('\nFailed:', error instanceof Error ? error.message : error, '\n');
  process.exit(1);
});
