/**
 * Runs one maintenance pass (reminders, expiry removals, reconciliation,
 * broadcast drain) and prints the report. Useful locally and from any external
 * scheduler that can run a command.
 *
 *   npm run cron
 */
import { disconnectFromDatabase } from '../src/db/connect';
import { runScheduledWork } from '../src/jobs/scheduler';
import { createLogger } from '../src/utils/logger';

const log = createLogger('run-cron');

async function main(): Promise<void> {
  const report = await runScheduledWork();
  console.log(JSON.stringify(report, null, 2));
  await disconnectFromDatabase();
  process.exit(report.errors.length > 0 ? 1 : 0);
}

main().catch((error) => {
  log.error('Cron run failed', error);
  process.exit(1);
});
