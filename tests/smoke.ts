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
import {
  chunkMessage,
  escapeHtml,
  isValidEmail,
  sliceCharacters,
  stripLoneSurrogates,
  truncate,
} from '../src/utils/text';
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

  console.log('\nFree month configuration');

  await check('the free month is off until all four settings are present', () => {
    assert.equal(parseEnvWith({}).trialEnabled, false);
    const partial = parseEnvWith({ TRIAL_SOURCE_CHAT_ID: '-1009999999999', TRIAL_ELIGIBLE_FROM: '2026-08-01T00:00:00+01:00' });
    assert.equal(partial.ok, true);
    assert.equal(partial.trialEnabled, false, 'without the API id/hash it must stay off');
    const full = parseEnvWith({
      TRIAL_SOURCE_CHAT_ID: '-1009999999999',
      TRIAL_ELIGIBLE_FROM: '2026-08-01T00:00:00+01:00',
      TELEGRAM_API_ID: '12345',
      TELEGRAM_API_HASH: 'abc',
    });
    assert.equal(full.trialEnabled, true);
  });

  await check('a malformed cutoff date is refused', () => {
    const result = parseEnvWith({ TRIAL_ELIGIBLE_FROM: '1st August' });
    assert.equal(result.ok, false);
    assert.match(String(result.message), /TRIAL_ELIGIBLE_FROM/);
  });

  await check('the free-month source cannot be the paid channel itself', () => {
    const result = parseEnvWith({ TRIAL_SOURCE_CHAT_ID: '-1001234567890' });
    assert.equal(result.ok, false);
    assert.match(String(result.message), /different chat/);
  });

  console.log('\nFull-API membership lookup');
  const { toMtprotoChannelId, interpretParticipant } = await import('../src/services/mtproto');
  const { Api } = await import('telegram');
  const bigInt = (await import('big-integer')).default;

  await check('Bot API channel ids map onto full-API channel ids', () => {
    assert.equal(toMtprotoChannelId(-1001234567890).toString(), '1234567890');
    assert.throws(() => toMtprotoChannelId(-123456), /not a channel or supergroup/);
  });

  await check('a member is read with their exact join date', () => {
    const joined = Date.UTC(2026, 7, 5, 10) / 1000;
    const result = interpretParticipant(new Api.ChannelParticipant({ userId: bigInt(1), date: joined }));
    assert.deepEqual(result, { status: 'member', joinedAt: new Date(joined * 1000), role: 'member' });
  });

  await check('left and banned people are not members', () => {
    const left = interpretParticipant(new Api.ChannelParticipantLeft({ peer: new Api.PeerUser({ userId: bigInt(1) }) }));
    assert.deepEqual(left, { status: 'not_member' });
  });

  await check('the creator is a member with no join date', () => {
    const creator = interpretParticipant(
      new Api.ChannelParticipantCreator({ userId: bigInt(1), adminRights: new Api.ChatAdminRights({}) }),
    );
    assert.deepEqual(creator, { status: 'member', joinedAt: null, role: 'creator' });
  });

  console.log('\nIgnoring group chatter');
  const { isIgnorableUpdate } = await import('../src/bot/middlewares');
  const PAID = -1001234567890;
  const SOURCE_GROUP = { id: -1009990001234, type: 'supergroup' };
  const ignorable = (chat: unknown, update: Record<string, unknown>) =>
    isIgnorableUpdate({ chat, update } as never, PAID);

  await check('messages posted in a group are dropped before the database', () => {
    assert.equal(ignorable(SOURCE_GROUP, { message: {} }), true);
    assert.equal(ignorable(SOURCE_GROUP, { edited_message: {} }), true);
  });

  await check('joins and leaves in the source group are dropped', () => {
    assert.equal(ignorable(SOURCE_GROUP, { chat_member: {} }), true);
  });

  await check('joins in the paid channel are kept (they start the free-month clock)', () => {
    assert.equal(ignorable({ id: PAID, type: 'channel' }, { chat_member: {} }), false);
  });

  await check('being added to any chat is kept (that is how the bot reports its id)', () => {
    assert.equal(ignorable(SOURCE_GROUP, { my_chat_member: {} }), false);
  });

  await check('everything in a private chat is kept', () => {
    assert.equal(ignorable({ id: 555, type: 'private' }, { message: {} }), false);
    assert.equal(ignorable({ id: 555, type: 'private' }, { callback_query: {} }), false);
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
    // Pin `now` explicitly: with a wall-clock default, the few milliseconds the
    // assertion itself takes tip 3 hours over into "2 hours".
    const now = new Date('2026-01-01T00:00:00.000Z');
    const target = new Date(now.getTime() + 2 * DAY + 3 * HOUR);
    assert.equal(humaniseRemaining(target, now), '2 days, 3 hours');
    assert.equal(humaniseRemaining(new Date(now.getTime() - 1000), now), 'expired');
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
  await check('cutting text never splits a character in half', () => {
    // Telegram answers "strings must be encoded in UTF-8" and rejects the whole
    // request if half a surrogate pair reaches it. These are real member names
    // shaped like the ones that stopped invite links being created in production.
    const realNames = [
      'Adaeze Chinwe Nkechi Okonkwo xx\u{1F408}\u200D\u2B1B Lagos',
      'Oluwaseun Temitope Adebayoxx xx\u{1F345}\u{1F410} FX',
      'Babatunde Chukwuemeka Olamidexx\u{1F410}',
      'Zainab Musa Abubakar Signals xx\u{1F47E}\u{1F199} VIP',
    ];
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

    for (const name of realNames) {
      // The old code did exactly this, and produced a broken string.
      assert.match(`${name} ABCD`.slice(0, 32), lone, 'this name must be one that used to break');

      const safe = stripLoneSurrogates(`${sliceCharacters(name, 26)} ABCD`);
      assert.doesNotMatch(safe, lone, `still broken for ${name}`);
      assert.ok(Array.from(safe).length <= 32, 'and must fit the 32-character limit');
    }
  });

  await check('truncate keeps emoji whole at every length', () => {
    const value = `${'a'.repeat(10)}\u{1F989}\u{1F989}\u{1F989}`;
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    for (let max = 2; max <= 16; max += 1) assert.doesNotMatch(truncate(value, max), lone, `broken at max=${max}`);
  });

  await check('splits messages under the Telegram limit', () => {
    const chunks = chunkMessage('line\n'.repeat(2000));
    assert.ok(chunks.length > 1);
    for (const chunk of chunks) assert.ok(chunk.length <= 4096);
  });

  console.log('\nUnfinished payments');
  const texts = await import('../src/bot/texts');

  await check('the "not completed" message tells people they need not keep checking', () => {
    const body = texts.paymentPending();
    assert.match(body, /not completed yet/i);
    assert.match(body, /do not need to keep checking/i);
    assert.match(body, /Pay Now/);
  });

  await check('Paystack statuses map to the right outcome', () => {
    const verdict = (status: string) =>
      paystackGateway.parseWebhook({ event: 'charge.success', data: { reference: 'r', status } }).actionable;
    // Only a successful charge event ever grants access.
    assert.equal(verdict('success'), true);
    assert.equal(paystackGateway.parseWebhook({ event: 'charge.failed', data: { reference: 'r' } }).actionable, false);
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

  await check('cron async mode answers immediately for external pingers', async () => {
    // Must not do the work inline: pingers time out at ~30s and report failure.
    const started = Date.now();
    const response = await fetch(`${base}/api/cron/run?async=1`, {
      method: 'POST',
      headers: { 'x-cron-secret': 'cron-secret-value' },
    });
    assert.equal(response.status, 202);
    const body = (await response.json()) as { ok: boolean; chain: string };
    assert.equal(body.ok, true);
    assert.ok(Date.now() - started < 10_000, 'the reply must come back fast');
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
