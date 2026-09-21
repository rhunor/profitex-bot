/**
 * Brings the plan catalogue in line with the list in src/services/plan-seed.ts:
 * names, prices, durations, badges and order.
 *
 *   npm run sync-plans
 *
 * Existing subscriptions are untouched — each one keeps the price and duration
 * captured when it was paid for, so nobody's end date moves.
 */
import { connectToDatabase, disconnectFromDatabase } from '../src/db/connect';
import { Plan } from '../src/models';
import { syncPlans } from '../src/services/plan-seed';
import { formatMoney } from '../src/utils/money';
import { planDuration } from '../src/bot/texts';

async function main(): Promise<void> {
  await connectToDatabase();
  const changes = await syncPlans();

  console.log('');
  for (const change of changes) console.log(`  ${change.action.padEnd(9)} ${change.code}`);

  console.log('\nCatalogue now on sale:\n');
  for (const plan of await Plan.find({ isActive: true }).sort({ sortOrder: 1 }).lean()) {
    console.log(
      `  ${plan.name.padEnd(10)} ${formatMoney(plan.priceMinor, plan.currency).padStart(10)}  ${planDuration(plan.durationDays).padEnd(9)} ${plan.badge ? '⭐ ' + plan.badge : ''}`,
    );
  }
  console.log('');

  await disconnectFromDatabase();
}

main().catch((error) => {
  console.error('Failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
