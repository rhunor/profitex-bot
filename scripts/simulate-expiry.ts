/**
 * Moves a subscriber's end date so the reminder and removal paths can be
 * exercised without waiting a month.
 *
 *   tsx scripts/simulate-expiry.ts <telegramId> <daysFromNow>
 *
 * Examples:
 *   tsx scripts/simulate-expiry.ts 123456789 7      # due the 7-day reminder
 *   tsx scripts/simulate-expiry.ts 123456789 0.5    # due the 24-hour reminder
 *   tsx scripts/simulate-expiry.ts 123456789 -1     # already expired: removal
 */
import { connectToDatabase, disconnectFromDatabase } from '../src/db/connect';
import { Subscription } from '../src/models';
import { formatDate, DAY } from '../src/utils/time';
import { createLogger } from '../src/utils/logger';

const log = createLogger('simulate-expiry');

async function main(): Promise<void> {
  const [idRaw, daysRaw] = process.argv.slice(2);
  const telegramId = Number(idRaw);
  const days = Number(daysRaw);

  if (!Number.isInteger(telegramId) || !Number.isFinite(days)) {
    console.error('Usage: tsx scripts/simulate-expiry.ts <telegramId> <daysFromNow>');
    process.exit(1);
  }

  await connectToDatabase();

  const subscription = await Subscription.findOne({ telegramId }).sort({ createdAt: -1 });
  if (!subscription) {
    console.error(`No subscription found for ${telegramId}.`);
    process.exit(1);
  }

  subscription.expiresAt = new Date(Date.now() + days * DAY);
  subscription.status = 'active';
  // Clear the flags so the reminder for the new window can fire again.
  subscription.remindersSent = {};
  subscription.removalNoticeSentAt = undefined;
  await subscription.save();

  console.log(`\nSubscription for ${telegramId} now expires: ${formatDate(subscription.expiresAt)}`);
  console.log('Run `npm run cron` to trigger the reminder or removal.\n');

  await disconnectFromDatabase();
}

main().catch((error) => {
  log.error('Failed', error);
  process.exit(1);
});
