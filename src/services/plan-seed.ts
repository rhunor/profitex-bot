import { getEnv } from '../config/env';
import { Plan } from '../models';
import { createLogger } from '../utils/logger';

const log = createLogger('plan-seed');

/** Starter catalogue. Placeholder prices — change them from /admin -> Plans. */
export const DEFAULT_PLANS = [
  {
    code: 'monthly',
    name: '1 Month',
    description: 'Full access to signals, analysis and mentorship for one month.',
    priceMinor: 2_000_000, // NGN 20,000
    durationDays: 30,
    sortOrder: 10,
    badge: undefined as string | undefined,
  },
  {
    code: 'quarterly',
    name: '3 Months',
    description: 'Three months of access \u2014 better value than paying monthly.',
    priceMinor: 5_500_000, // NGN 55,000
    durationDays: 90,
    sortOrder: 20,
    badge: 'Most Popular' as string | undefined,
  },
  {
    code: 'biannual',
    name: '6 Months',
    description: 'Half a year of access at a lower monthly rate.',
    priceMinor: 10_000_000, // NGN 100,000
    durationDays: 180,
    sortOrder: 30,
    badge: undefined as string | undefined,
  },
  {
    code: 'yearly',
    name: '1 Year',
    description: 'A full year of access at the best rate.',
    priceMinor: 19_000_000, // NGN 190,000
    durationDays: 365,
    sortOrder: 40,
    badge: undefined as string | undefined,
  },
];

/**
 * Brings the catalogue in line with DEFAULT_PLANS: prices, names, durations,
 * badges and order. Plans not listed here are left alone, so anything added
 * from /admin survives. Existing subscriptions are unaffected — each one keeps
 * the price and duration captured when it was paid for.
 */
export async function syncPlans(): Promise<Array<{ code: string; action: string }>> {
  const env = getEnv();
  const changes: Array<{ code: string; action: string }> = [];

  for (const plan of DEFAULT_PLANS) {
    const existing = await Plan.findOne({ code: plan.code });
    if (!existing) {
      await Plan.create({ ...plan, currency: env.CURRENCY, isActive: true });
      changes.push({ code: plan.code, action: 'created' });
      continue;
    }
    const before = `${existing.name}/${existing.priceMinor}/${existing.durationDays}/${existing.badge ?? '-'}`;
    existing.name = plan.name;
    existing.description = plan.description;
    existing.priceMinor = plan.priceMinor;
    existing.durationDays = plan.durationDays;
    existing.sortOrder = plan.sortOrder;
    existing.badge = plan.badge;
    existing.isActive = true;
    await existing.save();
    const after = `${existing.name}/${existing.priceMinor}/${existing.durationDays}/${existing.badge ?? '-'}`;
    changes.push({ code: plan.code, action: before === after ? 'unchanged' : 'updated' });
  }

  return changes;
}


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
