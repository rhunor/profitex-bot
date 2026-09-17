/**
 * Creates the starter plan set. Safe to re-run: existing plan codes are left
 * exactly as they are, so prices edited from the bot are never overwritten.
 *
 *   npm run seed
 */
import { getEnv } from '../src/config/env';
import { connectToDatabase, disconnectFromDatabase } from '../src/db/connect';
import { Plan } from '../src/models';
import { DEFAULT_PLANS, seedMissingPlans } from '../src/services/plan-seed';
import { formatMoney } from '../src/utils/money';
import { createLogger } from '../src/utils/logger';

const log = createLogger('seed');



async function main(): Promise<void> {
  const env = getEnv();
  await connectToDatabase();

  const created = await seedMissingPlans();
  for (const plan of DEFAULT_PLANS) {
    log.info(created.includes(plan.code)
      ? `Created plan "${plan.code}" at ${formatMoney(plan.priceMinor, env.CURRENCY)}`
      : `Plan "${plan.code}" already exists \u2014 left unchanged`);
  }

  const all = await Plan.find({}).sort({ sortOrder: 1 }).lean();
  console.log('\nPlans now configured:');
  for (const plan of all) {
    console.log(
      `  ${plan.isActive ? '[on sale]' : '[retired]'} ${plan.code.padEnd(12)} ${plan.name.padEnd(22)} ${formatMoney(plan.priceMinor, plan.currency).padStart(12)}  ${plan.durationDays} days`,
    );
  }
  console.log('\nEdit prices any time from the bot: /admin → Plans\n');

  await disconnectFromDatabase();
}

main().catch((error) => {
  log.error('Seeding failed', error);
  process.exit(1);
});
