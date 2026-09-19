/**
 * Checks, against the real source community, whether one person would get the
 * free month — step by step, without granting anything.
 *
 *   npm run check-trial -- <telegram id>
 *
 * Uses a throwaway full-API session, so running it locally never disturbs the
 * session the live deployment uses. Needs TELEGRAM_API_ID, TELEGRAM_API_HASH,
 * TRIAL_SOURCE_CHAT_ID and TRIAL_ELIGIBLE_FROM in .env.local (or the shell).
 */
process.env.MTPROTO_EPHEMERAL = '1';

import { getEnv } from '../src/config/env';
import { diagnoseLookup } from '../src/services/mtproto';
import { formatDate } from '../src/utils/time';

async function main(): Promise<void> {
  const userId = Number(process.argv[2]);
  const env = getEnv();
  const chatId = env.TRIAL_SOURCE_CHAT_ID;

  if (!chatId) throw new Error('Set TRIAL_SOURCE_CHAT_ID first.');
  if (!Number.isInteger(userId) || userId <= 0) throw new Error('Usage: npm run check-trial -- <telegram id>');

  console.log(`\nSource community ${chatId}, person ${userId}`);
  if (env.trialEligibleFrom) console.log(`Qualifies if they joined on or after ${formatDate(env.trialEligibleFrom)}\n`);

  const steps = await diagnoseLookup(chatId, userId);
  for (const step of steps) console.log(`${step.ok ? '✅' : '❌'} ${step.step}\n   ${step.detail}`);

  const joined = steps.at(-1)?.detail.match(/joined (\S+)/)?.[1];
  if (joined && env.trialEligibleFrom && !Number.isNaN(Date.parse(joined))) {
    const qualifies = new Date(joined) >= env.trialEligibleFrom;
    console.log(`\n${qualifies ? '\u{1F381} QUALIFIES for the free month' : '✖ Joined before the cutoff — does not qualify'}\n`);
  } else {
    console.log('');
  }
  process.exit(steps.every((s) => s.ok) ? 0 : 1);
}

main().catch((error) => {
  console.error('\nFailed:', error instanceof Error ? error.message : error, '\n');
  process.exit(1);
});
