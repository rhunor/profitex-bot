import path from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';

// Local files only — managed platforms (Vercel, Railway) inject env directly.
// `.env.local` is loaded first and wins, matching the convention Next.js and
// Vercel use; `.env` then fills in anything it did not set. dotenv never
// overwrites a variable that is already present in the environment.
for (const file of ['.env.local', '.env']) {
  dotenv.config({ path: path.resolve(process.cwd(), file) });
}

const boolish = z
  .union([z.boolean(), z.string()])
  .optional()
  .transform((v) => {
    if (typeof v === 'boolean') return v;
    if (v === undefined) return undefined;
    return ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
  });

const csvNumbers = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => Number(s))
      .filter((n) => Number.isFinite(n)),
  );

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  PORT: z.coerce.number().int().positive().default(3000),

  /** `polling` for local development, `webhook` for any hosted deployment. */
  BOT_MODE: z.enum(['polling', 'webhook']).default('polling'),
  BOT_TOKEN: z.string().min(20, 'BOT_TOKEN is missing or malformed'),
  /** Public HTTPS base URL of this deployment. Required in webhook mode. */
  PUBLIC_URL: z.string().url().optional(),
  /** Random string; Telegram echoes it back in X-Telegram-Bot-Api-Secret-Token. */
  TELEGRAM_WEBHOOK_SECRET: z.string().min(8).optional(),

  MONGODB_URI: z.string().min(10, 'MONGODB_URI is required'),
  MONGODB_DB_NAME: z.string().optional(),

  /**
   * Supergroup id, always negative, e.g. -1001234567890. Optional so the bot can
   * be deployed before the group is connected: once it is added to a group as
   * an admin, it messages every admin that group's id.
   */
  GROUP_CHAT_ID: z.coerce.number().int().optional(),
  GROUP_NAME: z.string().default('Profitable Forex Trading Academy'),
  /**
   * What GROUP_CHAT_ID points at. Only changes wording ("join the channel" vs
   * "join the group") and which admin rights are checked — access control
   * works identically for both.
   */
  COMMUNITY_TYPE: z.enum(['channel', 'group']).default('channel'),
  BRAND_NAME: z.string().default('Profitex'),
  SUPPORT_USERNAME: z.string().optional(),

  ADMIN_TELEGRAM_IDS: csvNumbers,

  /* ── Free month for members of another community ─────────────────────────
     Anyone who joined TRIAL_SOURCE_CHAT_ID on or after TRIAL_ELIGIBLE_FROM gets
     one free month the first time they message the bot. Reading a member's join
     date needs Telegram's full API, hence the api id/hash from my.telegram.org.
     The feature is off unless all four of these are set. */
  TRIAL_SOURCE_CHAT_ID: z.coerce.number().int().optional(),
  /** ISO timestamp, e.g. 2026-08-01T00:00:00+01:00 (midnight, Lagos time). */
  TRIAL_ELIGIBLE_FROM: z
    .string()
    .optional()
    .refine((v) => v === undefined || !Number.isNaN(Date.parse(v)), 'must be an ISO date, e.g. 2026-08-01T00:00:00+01:00'),
  TRIAL_DAYS: z.coerce.number().int().positive().max(365).default(30),
  TELEGRAM_API_ID: z.coerce.number().int().positive().optional(),
  TELEGRAM_API_HASH: z.string().optional(),

  PAYSTACK_SECRET_KEY: z.string().optional(),
  FLUTTERWAVE_SECRET_KEY: z.string().optional(),
  /** The "secret hash" configured on the Flutterwave dashboard webhook settings. */
  FLUTTERWAVE_SECRET_HASH: z.string().optional(),

  CURRENCY: z.string().length(3).default('NGN'),

  /** Shared secret protecting /api/cron/run. */
  CRON_SECRET: z.string().min(8).optional(),
  /** Run the in-process node-cron scheduler (standalone hosts). Off for serverless. */
  ENABLE_INTERNAL_CRON: boolish,
  CRON_SCHEDULE: z.string().default('*/15 * * * *'),
  APP_TIMEZONE: z.string().default('Africa/Lagos'),

  /** How long a freshly issued single-use invite link stays valid. */
  INVITE_LINK_TTL_MINUTES: z.coerce.number().int().positive().default(60),
  /** Private messages per second during a broadcast. Telegram tolerates ~30/s. */
  BROADCAST_RATE_PER_SEC: z.coerce.number().int().positive().max(30).default(20),
  /** Wall-clock budget for one broadcast worker pass (serverless friendly). */
  BROADCAST_BUDGET_MS: z.coerce.number().int().positive().default(40_000),
  /**
   * Wall-clock budget for one maintenance pass. Must sit comfortably inside the
   * host's per-invocation limit (Vercel functions default to 300s; 50s leaves
   * plenty of headroom and keeps each pass cheap).
   */
  SCHEDULER_BUDGET_MS: z.coerce.number().int().positive().default(50_000),
  /** Safety cap on how many follow-up passes a single trigger may chain. */
  MAX_SCHEDULER_CHAIN: z.coerce.number().int().min(0).max(50).default(12),
  /** Kick anyone found in the group without an active subscription. */
  ENFORCE_PAID_MEMBERS_ONLY: boolish,
});

export type AppEnv = Omit<z.infer<typeof schema>, 'GROUP_CHAT_ID'> & {
  /** 0 until GROUP_CHAT_ID is configured; check `groupConfigured`. */
  GROUP_CHAT_ID: number;
  groupConfigured: boolean;
  /** Running as a Vercel function (Vercel sets VERCEL=1 on every deployment). */
  onVercel: boolean;
  /** All four free-month settings are present. */
  trialEnabled: boolean;
  /** Parsed TRIAL_ELIGIBLE_FROM. */
  trialEligibleFrom: Date | null;
  paystackEnabled: boolean;
  flutterwaveEnabled: boolean;
  adminIds: Set<number>;
};

/**
 * A variable present but blank means "not set".
 *
 * Half-filled `.env` files are normal during setup, and a blank value in the
 * Vercel dashboard is easy to create by accident. Stripping them here lets every
 * field fall back to its default or its optional branch, instead of an empty
 * string failing a `.url()` or `.min()` rule and taking the whole config down.
 */
function withoutBlanks(source: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const trimmed = String(value).trim();
    if (trimmed === '') continue;
    result[key] = trimmed;
  }
  return result;
}

function build(): AppEnv {
  const parsed = schema.safeParse(withoutBlanks(process.env));
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(
      `Invalid environment configuration:\n${issues}\n\n` +
        'Set these in .env.local (local) or in your host\'s environment variables (deployed).\n' +
        'DEPLOYMENT.md has the full reference table.',
    );
  }
  const value = parsed.data;

  // On Vercel the right answers for these are fixed, so derive them instead of
  // relying on someone remembering to change three variables in the dashboard.
  // A function never long-polls and never runs an in-process scheduler, and
  // Vercel already knows the project's production URL.
  const onVercel = Boolean(process.env.VERCEL);
  if (onVercel) {
    value.BOT_MODE = 'webhook';
    value.ENABLE_INTERNAL_CRON = false;
    if (!value.PUBLIC_URL && process.env.VERCEL_PROJECT_PRODUCTION_URL) {
      value.PUBLIC_URL = `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
    }
  }

  const paystackEnabled = Boolean(value.PAYSTACK_SECRET_KEY);
  // FLUTTERWAVE-DISABLED: forced off for the Paystack-only launch, even if a
  // key is present. Restore to: Boolean(value.FLUTTERWAVE_SECRET_KEY)
  const flutterwaveEnabled = false;

  // Deliberately not fatal. A gateway is needed to *sell*, but the bot is
  // perfectly usable without one during setup — admins can still grant access
  // by hand — and refusing to boot would stop `npm run doctor` from
  // diagnosing anything else. The plan handler shows subscribers a clear
  // "payments unavailable" message while this is true.
  if (!paystackEnabled && !flutterwaveEnabled) {
    console.warn(
      '[env] No payment gateway configured. Subscribers cannot pay until ' +
        'PAYSTACK_SECRET_KEY is set.',
    );
  }
  if (value.BOT_MODE === 'webhook' && !value.PUBLIC_URL) {
    throw new Error('PUBLIC_URL is required when BOT_MODE=webhook.');
  }
  if (value.TRIAL_SOURCE_CHAT_ID !== undefined && value.TRIAL_SOURCE_CHAT_ID >= 0) {
    throw new Error('TRIAL_SOURCE_CHAT_ID must be the negative id of the channel or group, e.g. -1001234567890.');
  }
  if (value.TRIAL_SOURCE_CHAT_ID !== undefined && value.TRIAL_SOURCE_CHAT_ID === value.GROUP_CHAT_ID) {
    throw new Error('TRIAL_SOURCE_CHAT_ID must be a different chat from GROUP_CHAT_ID (the paid channel).');
  }
  const trialEligibleFrom = value.TRIAL_ELIGIBLE_FROM ? new Date(value.TRIAL_ELIGIBLE_FROM) : null;
  const trialEnabled = Boolean(
    value.TRIAL_SOURCE_CHAT_ID && trialEligibleFrom && value.TELEGRAM_API_ID && value.TELEGRAM_API_HASH,
  );

  if (value.GROUP_CHAT_ID !== undefined && value.GROUP_CHAT_ID >= 0) {
    throw new Error('GROUP_CHAT_ID must be the negative id of a supergroup, e.g. -1001234567890.');
  }

  return {
    ...value,
    GROUP_CHAT_ID: value.GROUP_CHAT_ID ?? 0,
    groupConfigured: value.GROUP_CHAT_ID !== undefined,
    onVercel,
    trialEnabled,
    trialEligibleFrom,
    paystackEnabled,
    flutterwaveEnabled,
    adminIds: new Set(value.ADMIN_TELEGRAM_IDS),
  };
}

let cached: AppEnv | null = null;

export function getEnv(): AppEnv {
  if (!cached) cached = build();
  return cached;
}

export const env: AppEnv = new Proxy({} as AppEnv, {
  get(_target, prop: string) {
    return (getEnv() as unknown as Record<string, unknown>)[prop];
  },
  has(_target, prop: string) {
    return prop in getEnv();
  },
});

/** Absolute URL for a path on this deployment. */
export function publicUrl(pathname: string): string {
  const base = getEnv().PUBLIC_URL;
  if (!base) throw new Error('PUBLIC_URL is not configured.');
  return new URL(pathname, base).toString();
}
