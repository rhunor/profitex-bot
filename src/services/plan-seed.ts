import { getEnv } from '../config/env';
import { Plan } from '../models';
import { createLogger } from '../utils/logger';

const log = createLogger('plan-seed');

/** Starter catalogue. Placeholder prices — change them from /admin -> Plans. */
export const DEFAULT_PLANS = [
  {
    code: 'monthly',
    name: 'Monthly Access',
    description: 'Full access to signals, analysis and mentorship for one month.',
    priceMinor: 2_500_000, // NGN 25,000
    durationDays: 30,
    sortOrder: 10,
  },
  {
    code: 'quarterly',
    name: 'Quarterly Access',
    description: 'Three months of access — better value than paying monthly.',
    priceMinor: 6_500_000, // NGN 65,000
    durationDays: 90,
    sortOrder: 20,
  },
  {
    code: 'yearly',
    name: 'Yearly Access',
    description: 'A full year of access at the best rate.',
    priceMinor: 20_000_000, // NGN 200,000
    durationDays: 365,
    sortOrder: 30,
  },
];

/**
 * Creates any starter plan whose code does not exist yet. Existing plans are
 * never modified, so prices edited from the bot are never overwritten.
 */
export async function seedMissingPlans(): Promise<string[]> {
  const env = getEnv();
  const created: string[] = [];
  for (const plan of DEFAULT_PLANS) {
    if (await Plan.exists({ code: plan.code })) continue;
    await Plan.create({ ...plan, currency: env.CURRENCY, isActive: true });
    created.push(plan.code);
  }
  if (created.length) log.info('Created starter plans', { created });
  return created;
}

/** Seeds only a completely empty catalogue — used by the browser setup link. */
export async function seedIfCatalogueEmpty(): Promise<string[]> {
  if ((await Plan.countDocuments({})) > 0) return [];
  return seedMissingPlans();
}
