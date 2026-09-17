import { getEnv } from '../config/env';
import { createLogger } from '../utils/logger';
import { processBroadcastQueue } from './broadcast.service';

const log = createLogger('dispatch');

export type ChainOutcome = 'chained' | 'in-process' | 'max-depth' | 'unconfigured' | 'failed';

/**
 * Asks this deployment to run another maintenance pass, in a fresh invocation.
 *
 * This is what makes a once-a-day scheduler sufficient. A single trigger can
 * fan out into as many passes as the backlog needs: each pass works until its
 * time budget is spent, then hands off to the next one.
 *
 * The request is deliberately *awaited* with a short timeout rather than fired
 * and forgotten. On a serverless host the current invocation can be frozen the
 * instant it sends its response, and a forgotten request may never leave the
 * process. Awaiting guarantees the next invocation has started; the timeout
 * then aborts our side of the connection without disturbing it, because the
 * receiving function keeps running after the caller disconnects.
 */
export async function chainFollowUpPass(
  depth: number,
  mode: 'full' | 'broadcast' = 'full',
): Promise<ChainOutcome> {
  const env = getEnv();

  if (depth >= env.MAX_SCHEDULER_CHAIN) {
    log.warn(`Chain depth limit (${env.MAX_SCHEDULER_CHAIN}) reached; the next scheduled run will continue`);
    return 'max-depth';
  }

  if (!env.PUBLIC_URL || !env.CRON_SECRET) {
    log.warn('Cannot chain a follow-up pass: PUBLIC_URL and CRON_SECRET are both required');
    return 'unconfigured';
  }

  const url = new URL('/api/cron/run', env.PUBLIC_URL);
  url.searchParams.set('mode', mode);
  url.searchParams.set('depth', String(depth + 1));

  try {
    await fetch(url.toString(), {
      method: 'POST',
      headers: { 'x-cron-secret': env.CRON_SECRET },
      signal: AbortSignal.timeout(2_500),
    });
    return 'chained';
  } catch (error) {
    // An abort here is the expected path: the follow-up pass takes far longer
    // than our timeout, and we only ever needed it to start.
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      return 'chained';
    }
    log.error('Could not start a follow-up pass', error);
    return 'failed';
  }
}

/**
 * Starts draining the broadcast queue.
 *
 * On an always-on host the work simply runs in this process. On a serverless
 * host the current invocation may be frozen as soon as it responds, so the work
 * is handed to a dedicated invocation instead.
 */
export async function kickBroadcastWorker(): Promise<ChainOutcome> {
  const env = getEnv();

  if (env.ENABLE_INTERNAL_CRON) {
    void processBroadcastQueue().catch((error) => {
      log.error('In-process broadcast pass failed', error);
    });
    return 'in-process';
  }

  return chainFollowUpPass(0, 'broadcast');
}
