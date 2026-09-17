/**
 * Offline smoke test: exercises the logic that must be right before any money
 * or membership changes hands, with no database and no network calls.
 *
 *   npx tsx tests/smoke.ts
 */
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// A complete, syntactically valid environment so getEnv() succeeds.
Object.assign(process.env, {
  NODE_ENV: 'test',
  LOG_LEVEL: 'error',
  BOT_TOKEN: '1234567890:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  BOT_MODE: 'webhook',
  PUBLIC_URL: 'https://example.test',
  TELEGRAM_WEBHOOK_SECRET: 'telegram-secret-value',
  MONGODB_URI: 'mongodb://127.0.0.1:27017/profitex-test',
  MONGODB_DB_NAME: 'profitex-test',
  GROUP_CHAT_ID: '-1001234567890',
  ADMIN_TELEGRAM_IDS: '111,222',
  PAYSTACK_SECRET_KEY: 'sk_test_paystackkey',
  FLUTTERWAVE_SECRET_KEY: 'FLWSECK_TEST-flutterwavekey-X',
  FLUTTERWAVE_SECRET_HASH: 'flw-hash-value',
  CRON_SECRET: 'cron-secret-value',
  CURRENCY: 'NGN',
  ENABLE_INTERNAL_CRON: 'false',
  INVITE_LINK_TTL_MINUTES: '60',
});

/* eslint-disable @typescript-eslint/no-var-requires */
import { getEnv } from '../src/config/env';
import { formatMoney, parseAmountToMinor, toMajor, toMinor } from '../src/utils/money';
import { addDays, humaniseRemaining, DAY, HOUR } from '../src/utils/time';
import { buildPaymentReference } from '../src/utils/reference';
import { chunkMessage, escapeHtml, isValidEmail } from '../src/utils/text';
import { paystackGateway } from '../src/services/payments/paystack';
import { flutterwaveGateway } from '../src/services/payments/flutterwave';
import { enabledGateways } from '../src/services/payments';
import { dueReminder } from '../src/jobs/reminders';
import { createApp } from '../src/http/app';
import type { ISubscription } from '../src/models';

let passed = 0;
function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log(`  ✅ ${name}`);
    })
    .catch((error) => {
      console.error(`  ❌ ${name}\n     ${error instanceof Error ? error.message : error}`);
      process.exitCode = 1;
    });
}

async function main(): Promise<void> {
  console.log('\nProfitex bot — offline smoke test\n');

  console.log('Environment');
  await check('loads and derives gateway flags', () => {
    const env = getEnv();
    assert.equal(env.GROUP_CHAT_ID, -1001234567890);
    assert.equal(env.paystackEnabled, true);
    // FLUTTERWAVE-DISABLED: stays off even though a key is present.
    assert.equal(env.flutterwaveEnabled, false);
    assert.deepEqual([...env.adminIds], [111, 222]);
  });
  await check('only Paystack is offered while Flutterwave is disabled', () => {
    assert.deepEqual(enabledGateways().map((g) => g.id), ['paystack']);
  });

  console.log('\nBlank variables mean "not set"');

  // Half-filled .env files are normal during setup, and a blank value in a
  // hosting dashboard is easy to create by accident. Neither may take the whole
  // configuration down. Run from a directory with no .env files so only the
  // environment handed to the child process applies.
  const fixture = path.resolve(__dirname, 'fixtures/print-env.ts');
  const parseEnvWith = (overrides: Record<string, string>) => {
    const raw = execFileSync(process.execPath, [require.resolve('tsx/cli'), fixture], {
      cwd: os.tmpdir(),
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        BOT_TOKEN: '1234567890:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        MONGODB_URI: 'mongodb://127.0.0.1:27017/profitex-test',
        GROUP_CHAT_ID: '-1001234567890',
        PAYSTACK_SECRET_KEY: 'sk_test_paystackkey',
        ...overrides,
      },
    });
    return JSON.parse(raw) as Record<string, unknown>;
  };

  await check('a blank PUBLIC_URL does not fail the whole config', () => {
    const result = parseEnvWith({ PUBLIC_URL: '' });
    assert.equal(result.ok, true, `config refused to load: ${result.message}`);
    assert.equal(result.publicUrl, null);
  });

  await check('blank secrets read as unset rather than failing a length rule', () => {
    const result = parseEnvWith({ CRON_SECRET: '', TELEGRAM_WEBHOOK_SECRET: '', SUPPORT_USERNAME: '' });
    assert.equal(result.ok, true, `config refused to load: ${result.message}`);
    assert.equal(result.cronSecret, null);
    assert.equal(result.webhookSecret, null);
    assert.equal(result.supportUsername, null);
  });

  await check('blank values fall back to defaults instead of empty strings', () => {
    const result = parseEnvWith({ CURRENCY: '', GROUP_NAME: '', PORT: '' });
    assert.equal(result.ok, true, `config refused to load: ${result.message}`);
    assert.equal(result.currency, 'NGN');
    assert.equal(result.groupName, 'Profitable Forex Trading Academy');
    assert.equal(result.port, 3000, 'a blank PORT must not coerce to 0');
  });

  await check('whitespace-only values count as blank', () => {
    const result = parseEnvWith({ ADMIN_TELEGRAM_IDS: '   ', FLUTTERWAVE_SECRET_KEY: '  ' });
    assert.equal(result.ok, true, `config refused to load: ${result.message}`);
    assert.equal(result.adminCount, 0);
    assert.equal(result.flutterwaveEnabled, false);
  });

  await check('the bot still loads with no payment gateway at all', () => {
    // Needed during setup: a missing gateway must not stop the bot booting,
    // or `npm run doctor` could never diagnose anything else.
    const result = parseEnvWith({ PAYSTACK_SECRET_KEY: '', FLUTTERWAVE_SECRET_KEY: '' });
    assert.equal(result.ok, true, `config refused to load: ${result.message}`);
    assert.equal(result.paystackEnabled, false);
    assert.equal(result.flutterwaveEnabled, false);
  });

  await check('wording defaults to a channel, and can be switched to a group', () => {
    assert.equal(parseEnvWith({}).communityType, 'channel');
    assert.equal(parseEnvWith({ COMMUNITY_TYPE: 'group' }).communityType, 'group');
    assert.equal(parseEnvWith({ COMMUNITY_TYPE: 'forum' }).ok, false, 'an unknown type must be refused');
  });

  await check('the bot deploys before a group is connected', () => {
    const result = parseEnvWith({ GROUP_CHAT_ID: '' });
    assert.equal(result.ok, true, `config refused to load: ${result.message}`);
    assert.equal(result.groupConfigured, false);
    assert.equal(result.groupChatId, 0);
  });

  await check('on Vercel, mode, scheduler and URL are derived automatically', () => {
    // Pasting a local .env (polling, in-process cron, no URL) must still work.
    const result = parseEnvWith({
      VERCEL: '1',
      VERCEL_PROJECT_PRODUCTION_URL: 'profitex-bot.vercel.app',
      BOT_MODE: 'polling',
      ENABLE_INTERNAL_CRON: 'true',
      PUBLIC_URL: '',
    });
    assert.equal(result.ok, true, `config refused to load: ${result.message}`);
    assert.equal(result.onVercel, true);
    assert.equal(result.botMode, 'webhook');
    assert.equal(result.internalCron, false, 'an in-process scheduler would be frozen between requests');
    assert.equal(result.publicUrl, 'https://profitex-bot.vercel.app');
  });

  await check('an explicit PUBLIC_URL still wins on Vercel', () => {
    const result = parseEnvWith({
      VERCEL: '1',
      VERCEL_PROJECT_PRODUCTION_URL: 'profitex-bot.vercel.app',
      PUBLIC_URL: 'https://bot.profitex.com',
    });
    assert.equal(result.publicUrl, 'https://bot.profitex.com');
  });

  await check('a genuinely invalid value is still rejected', () => {
    const result = parseEnvWith({ GROUP_CHAT_ID: '1234567890' });
    assert.equal(result.ok, false, 'a positive GROUP_CHAT_ID must be refused');
    assert.match(String(result.message), /negative/i);
  });

  console.log('\nMoney (minor units)');
  await check('converts without floating point drift', () => {
    assert.equal(toMinor(25_000), 2_500_000);
    assert.equal(toMajor(2_500_000), 25_000);
    assert.equal(toMinor(1234.56), 123_456);
    assert.equal(toMinor(0.1 + 0.2), 30);
  });
  await check('formats naira', () => {
    assert.equal(formatMoney(2_500_000, 'NGN'), '₦25,000');
    assert.equal(formatMoney(123_456, 'NGN'), '₦1,234.56');
  });
  await check('parses admin price input', () => {
    assert.equal(parseAmountToMinor('25,000'), 2_500_000);
    assert.equal(parseAmountToMinor('₦25000'), 2_500_000);
    assert.equal(parseAmountToMinor('abc'), null);
    assert.equal(parseAmountToMinor('0'), null);
  });

  console.log('\nReminder buckets');
  const sub = (msFromNow: number): ISubscription =>
    ({ expiresAt: new Date(Date.now() + msFromNow) }) as ISubscription;

  await check('7-day window', () => {
    assert.equal(dueReminder(sub(6.5 * DAY)), 'd7');
    assert.equal(dueReminder(sub(7 * DAY - 1000)), 'd7');
  });
  await check('3-day window', () => {
    assert.equal(dueReminder(sub(3 * DAY - 1000)), 'd3');
    assert.equal(dueReminder(sub(2 * DAY)), 'd3');
  });
  await check('24-hour window', () => {
    assert.equal(dueReminder(sub(23 * HOUR)), 'h24');
    assert.equal(dueReminder(sub(1000)), 'h24');
  });
  await check('nothing due outside 7 days or after expiry', () => {
    assert.equal(dueReminder(sub(30 * DAY)), null);
    assert.equal(dueReminder(sub(-1000)), null);
  });

  console.log('\nDates');
  await check('addDays is exact', () => {
    const start = new Date('2026-01-31T12:00:00.000Z');
    assert.equal(addDays(start, 30).toISOString(), '2026-03-02T12:00:00.000Z');
  });
  await check('humanises remaining time', () => {
    assert.match(humaniseRemaining(new Date(Date.now() + 2 * DAY + 3 * HOUR)), /^2 days, 3 hours$/);
    assert.equal(humaniseRemaining(new Date(Date.now() - 1000)), 'expired');
  });

  console.log('\nReferences and text');
  await check('payment references are unique and carry the telegram id', () => {
    const a = buildPaymentReference(987654321);
    const b = buildPaymentReference(987654321);
    assert.notEqual(a, b);
    assert.ok(a.startsWith('PTX-987654321-'));
    assert.ok(/^[A-Za-z0-9-]+$/.test(a), 'reference must be URL safe');
  });
  await check('escapes HTML for Telegram', () => {
    assert.equal(escapeHtml('<b>&"x"</b>'), '&lt;b&gt;&amp;&quot;x&quot;&lt;/b&gt;');
  });
  await check('validates emails', () => {
    assert.equal(isValidEmail('trader@example.com'), true);
    assert.equal(isValidEmail('nope@nope'), false);
    assert.equal(isValidEmail('no-at-sign.com'), false);
  });
  await check('splits messages under the Telegram limit', () => {
    const chunks = chunkMessage('line\n'.repeat(2000));
    assert.ok(chunks.length > 1);
    for (const chunk of chunks) assert.ok(chunk.length <= 4096);
  });

  console.log('\nPaystack');
  await check('accepts a correctly signed webhook', () => {
    const body = Buffer.from(JSON.stringify({ event: 'charge.success', data: { reference: 'PTX-1' } }));
    const signature = createHmac('sha512', 'sk_test_paystackkey').update(body).digest('hex');
    assert.equal(paystackGateway.verifyWebhookSignature(body, { 'x-paystack-signature': signature }), true);
  });
  await check('rejects a tampered body', () => {
    const body = Buffer.from(JSON.stringify({ event: 'charge.success', data: { reference: 'PTX-1' } }));
    const signature = createHmac('sha512', 'sk_test_paystackkey').update(body).digest('hex');
    const tampered = Buffer.from(JSON.stringify({ event: 'charge.success', data: { reference: 'PTX-2' } }));
    assert.equal(paystackGateway.verifyWebhookSignature(tampered, { 'x-paystack-signature': signature }), false);
  });
  await check('rejects a missing signature', () => {
    assert.equal(paystackGateway.verifyWebhookSignature(Buffer.from('{}'), {}), false);
  });
  await check('only charge.success is actionable', () => {
    assert.deepEqual(
      paystackGateway.parseWebhook({ event: 'charge.success', data: { reference: 'PTX-9', id: 42 } }),
      { actionable: true, event: 'charge.success', reference: 'PTX-9', gatewayReference: '42' },
    );
    assert.equal(paystackGateway.parseWebhook({ event: 'charge.failed', data: { reference: 'PTX-9' } }).actionable, false);
    assert.equal(paystackGateway.parseWebhook({ event: 'transfer.success', data: {} }).actionable, false);
  });

  console.log('\nFlutterwave adapter (dormant, kept correct)');
  await check('accepts the configured verif-hash', () => {
    assert.equal(flutterwaveGateway.verifyWebhookSignature(Buffer.from('{}'), { 'verif-hash': 'flw-hash-value' }), true);
  });
  await check('rejects a wrong or missing hash', () => {
    assert.equal(flutterwaveGateway.verifyWebhookSignature(Buffer.from('{}'), { 'verif-hash': 'wrong' }), false);
    assert.equal(flutterwaveGateway.verifyWebhookSignature(Buffer.from('{}'), {}), false);
  });
  await check('only successful charge.completed is actionable', () => {
    const ok = flutterwaveGateway.parseWebhook({
      event: 'charge.completed',
      data: { tx_ref: 'PTX-5', id: 285959875, status: 'successful' },
    });
    assert.deepEqual(ok, { actionable: true, event: 'charge.completed', reference: 'PTX-5', gatewayReference: '285959875' });

    const failed = flutterwaveGateway.parseWebhook({
      event: 'charge.completed',
      data: { tx_ref: 'PTX-6', id: 1, status: 'failed' },
    });
    assert.equal(failed.actionable, false);
  });

  console.log('\nHTTP surface');
  const app = createApp();
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const base = `http://127.0.0.1:${port}`;

  await check('GET /health reports ok', async () => {
    const response = await fetch(`${base}/health`);
    assert.equal(response.status, 200);
    const json = (await response.json()) as { ok: boolean; service: string };
    assert.equal(json.ok, true);
    assert.equal(json.service, 'profitex-telegram-bot');
  });

  await check('Telegram webhook rejects a bad secret token', async () => {
    const response = await fetch(`${base}/api/telegram`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 'wrong' },
      body: JSON.stringify({ update_id: 1 }),
    });
    assert.equal(response.status, 401);
  });

  await check('Paystack webhook rejects an unsigned payload', async () => {
    const response = await fetch(`${base}/api/webhooks/paystack`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event: 'charge.success', data: { reference: 'PTX-1' } }),
    });
    assert.equal(response.status, 401);
  });

  await check('Flutterwave webhook route is switched off', async () => {
    // FLUTTERWAVE-DISABLED: expect 401 (bad verif-hash) once re-enabled.
    const response = await fetch(`${base}/api/webhooks/flutterwave`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'verif-hash': 'nope' },
      body: JSON.stringify({ event: 'charge.completed', data: { tx_ref: 'PTX-1', status: 'successful' } }),
    });
    assert.equal(response.status, 404);
  });

  await check('cron endpoint rejects an unauthenticated call', async () => {
    const response = await fetch(`${base}/api/cron/run`);
    assert.equal(response.status, 401);
  });

  await check('cron endpoint accepts the Vercel bearer form', async () => {
    // Authorised, then fails on the (deliberately unreachable) database:
    // a 401 here would mean the auth check itself is broken.
    const response = await fetch(`${base}/api/cron/run?mode=broadcast`, {
      headers: { authorization: 'Bearer cron-secret-value' },
    });
    assert.notEqual(response.status, 401);
  });

  await check('setup link refuses a missing secret', async () => {
    const response = await fetch(`${base}/api/setup`);
    assert.equal(response.status, 401);
  });

  await check('setup link refuses a wrong secret', async () => {
    const response = await fetch(`${base}/api/setup?secret=wrong`);
    assert.equal(response.status, 401);
  });

  await check('payment callback without a reference is a 400', async () => {
    const response = await fetch(`${base}/api/payment/callback`);
    assert.equal(response.status, 400);
  });

  await check('unknown routes are 404 JSON', async () => {
    const response = await fetch(`${base}/nope`);
    assert.equal(response.status, 404);
  });

  await new Promise<void>((resolve) => server.close(() => resolve()));

  console.log(`\n${passed} check(s) passed${process.exitCode ? ', with failures above' : ''}.\n`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
