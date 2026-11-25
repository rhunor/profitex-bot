/**
 * End-to-end lifecycle test against a real (in-memory) MongoDB.
 *
 *   npx tsx tests/integration.ts
 *
 * Telegram is stubbed with a grammY API transformer; the payment gateways are
 * stubbed at the fetch layer. Everything else — models, indexes, services and
 * jobs — is the real code path that runs in production.
 */
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { GrammyError } from 'grammy';

let passed = 0;
let failed = 0;

async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`  ✅ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  ❌ ${name}\n     ${error instanceof Error ? (error.stack ?? error.message) : error}`);
  }
}

function section(title: string): void {
  console.log(`\n${title}`);
}

/* ── Telegram stub ──────────────────────────────────────────── */

interface TelegramCall {
  method: string;
  payload: Record<string, unknown>;
}

const telegramCalls: TelegramCall[] = [];
/** Lets a test make one Telegram call fail. */
const telegramStub: { onCreateInviteLink?: () => void } = {};
let inviteCounter = 0;
let messageCounter = 0;

function callsTo(method: string): TelegramCall[] {
  return telegramCalls.filter((c) => c.method === method);
}

/* ── Gateway stub ───────────────────────────────────────────── */

interface GatewayScript {
  paystackVerify?: (reference: string) => unknown;
  flutterwaveVerify?: (reference: string) => unknown;
}

const script: GatewayScript = {};
const realFetch = globalThis.fetch;

function installGatewayStub(): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

    if (url.includes('api.paystack.co/transaction/initialize')) {
      return jsonResponse({
        status: true,
        message: 'Authorization URL created',
        data: { authorization_url: 'https://checkout.paystack.com/fake', access_code: 'ac', reference: 'ignored' },
      });
    }

    if (url.includes('api.paystack.co/transaction/verify/')) {
      const reference = decodeURIComponent(url.split('/verify/')[1]);
      return jsonResponse(script.paystackVerify?.(reference) ?? { status: false, message: 'not found' });
    }

    if (url.includes('api.flutterwave.com/v3/payments')) {
      return jsonResponse({ status: 'success', message: 'Hosted Link', data: { link: 'https://checkout.flutterwave.com/fake' } });
    }

    if (url.includes('api.flutterwave.com/v3/transactions')) {
      const reference = new URL(url).searchParams.get('tx_ref') ?? '';
      return jsonResponse(script.flutterwaveVerify?.(reference) ?? { status: 'error', message: 'No transaction was found' });
    }

    return realFetch(input as RequestInfo, init);
  }) as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/* ── Main ───────────────────────────────────────────────────── */

async function main(): Promise<void> {
  console.log('\nProfitex bot — lifecycle integration test\n');
  console.log('Starting in-memory MongoDB…');
  const mongo = await MongoMemoryServer.create();

  Object.assign(process.env, {
    NODE_ENV: 'test',
    LOG_LEVEL: 'error',
    BOT_TOKEN: '1234567890:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    BOT_MODE: 'webhook',
    PUBLIC_URL: 'https://example.test',
    TELEGRAM_WEBHOOK_SECRET: 'telegram-secret-value',
    MONGODB_URI: mongo.getUri(),
    MONGODB_DB_NAME: 'profitex-test',
    GROUP_CHAT_ID: '-1001234567890',
    ADMIN_TELEGRAM_IDS: '111',
    PAYSTACK_SECRET_KEY: 'sk_test_paystackkey',
    FLUTTERWAVE_SECRET_KEY: 'FLWSECK_TEST-flutterwavekey-X',
    FLUTTERWAVE_SECRET_HASH: 'flw-hash-value',
    CRON_SECRET: 'cron-secret-value',
    CURRENCY: 'NGN',
    ENABLE_INTERNAL_CRON: 'false',
    INVITE_LINK_TTL_MINUTES: '60',
    BROADCAST_RATE_PER_SEC: '30',
    BROADCAST_BUDGET_MS: '10000',
    // Free month: joined the source community on/after 1 Aug 2026, Lagos time.
    TRIAL_SOURCE_CHAT_ID: '-1009999999999',
    TRIAL_ELIGIBLE_FROM: '2026-08-01T00:00:00+01:00',
    TRIAL_DAYS: '30',
    TELEGRAM_API_ID: '12345',
    TELEGRAM_API_HASH: 'test-api-hash',
  });

  installGatewayStub();

  const { connectToDatabase, disconnectFromDatabase } = await import('../src/db/connect');
  const models = await import('../src/models');
  const { Plan, Payment, Subscription, InviteLink, User, Broadcast, BroadcastTarget } = models;
  const { getApi } = await import('../src/services/telegram');
  const { upsertUser } = await import('../src/services/user.service');
  const { initiatePayment, finalizePayment, reconcileUnfulfilledPayments, reconcileUserPayments, reconcilePendingPayments } =
    await import('../src/services/payment.service');
  const { activateOrExtend, snapshotFromPlan, getActiveSubscription } = await import('../src/services/subscription.service');
  const { issueInviteLink, findUsableLink } = await import('../src/services/invite.service');
  const { processReminders } = await import('../src/jobs/reminders');
  const { processExpirations } = await import('../src/jobs/expiry');
  const { runScheduledWork } = await import('../src/jobs/scheduler');
  const { createBroadcast, processBroadcastQueue, resolveAudience } = await import('../src/services/broadcast.service');
  const { DAY, addDays } = await import('../src/utils/time');

  // Stub every outgoing Telegram call.
  getApi().config.use(async (_prev, method, payload) => {
    telegramCalls.push({ method, payload: payload as Record<string, unknown> });

    switch (method) {
      case 'getMe':
        return { ok: true, result: { id: 1, is_bot: true, first_name: 'Profitex', username: 'profitex_test_bot' } } as never;
      case 'createChatInviteLink':
        telegramStub.onCreateInviteLink?.();
        inviteCounter += 1;
        return {
          ok: true,
          result: {
            invite_link: `https://t.me/+FAKEINVITE${inviteCounter}`,
            creator: { id: 1, is_bot: true, first_name: 'Profitex' },
            creates_join_request: false,
            is_primary: false,
            is_revoked: false,
          },
        } as never;
      case 'revokeChatInviteLink':
        return { ok: true, result: { invite_link: 'x', is_revoked: true } } as never;
      case 'sendMessage':
      case 'copyMessage':
        messageCounter += 1;
        return { ok: true, result: { message_id: messageCounter, date: 0, chat: { id: 1, type: 'private' } } } as never;
      case 'banChatMember':
      case 'unbanChatMember':
        return { ok: true, result: true } as never;
      case 'getChat': {
        const id = Number((payload as { chat_id: number }).chat_id);
        return {
          ok: true,
          result: {
            id,
            type: id === -1001234567890 ? 'channel' : 'supergroup',
            title: id === -1001234567890 ? 'PFT VIP Signals.' : 'Profitable FX Trading Academy',
          },
        } as never;
      }
      case 'getChatMember':
        return {
          ok: true,
          result: {
            status: 'administrator',
            user: { id: 1, is_bot: true, first_name: 'Profitex' },
            can_post_messages: true,
            can_invite_users: true,
            can_restrict_members: true,
          },
        } as never;
      default:
        return { ok: true, result: true } as never;
    }
  });

  await connectToDatabase();
  // Indexes must exist for the "one active subscription" guarantee to hold.
  await Promise.all([
    Subscription.syncIndexes(),
    Payment.syncIndexes(),
    InviteLink.syncIndexes(),
    User.syncIndexes(),
    Plan.syncIndexes(),
    BroadcastTarget.syncIndexes(),
  ]);

  const monthly = await Plan.create({
    code: 'monthly',
    name: 'Monthly Access',
    priceMinor: 2_500_000,
    currency: 'NGN',
    durationDays: 30,
    isActive: true,
  });

  const subscriber = await upsertUser({ id: 900001, first_name: 'Tunde', username: 'tunde_fx' });

  /* ── 1. First payment grants access ─────────────────────── */

  section('First payment');

  const { payment: firstPayment, checkoutUrl } = await initiatePayment({
    user: subscriber,
    plan: monthly,
    gateway: 'paystack',
    email: 'tunde@example.com',
  });

  await check('a pending payment record exists before checkout', async () => {
    const stored = await Payment.findOne({ reference: firstPayment.reference });
    assert.ok(stored);
    assert.equal(stored.status, 'pending');
    assert.equal(stored.amountMinor, 2_500_000);
    assert.equal(checkoutUrl, 'https://checkout.paystack.com/fake');
  });

  script.paystackVerify = (reference) => ({
    status: true,
    message: 'Verification successful',
    data: { id: 777, status: 'success', reference, amount: 2_500_000, currency: 'NGN', channel: 'card', paid_at: new Date().toISOString() },
  });

  const firstResult = await finalizePayment(firstPayment.reference, { trigger: 'test' });

  await check('a verified payment is fulfilled once', () => {
    assert.equal(firstResult.outcome, 'fulfilled');
    assert.equal(firstResult.isRenewal, false);
  });

  await check('the subscription runs 30 days from now', async () => {
    const sub = await getActiveSubscription(900001);
    assert.ok(sub);
    assert.equal(sub.status, 'active');
    assert.equal(sub.planSnapshot.code, 'monthly');
    const days = (sub.expiresAt.getTime() - Date.now()) / DAY;
    assert.ok(days > 29.9 && days < 30.1, `expected ~30 days, got ${days}`);
  });

  await check('a single-use invite link was created', async () => {
    const links = await InviteLink.find({ telegramId: 900001 });
    assert.equal(links.length, 1);
    assert.equal(links[0].status, 'active');
    assert.equal(links[0].memberLimit, 1);
    const call = callsTo('createChatInviteLink').at(-1);
    assert.equal(call?.payload.member_limit, 1);
    assert.ok(typeof call?.payload.expire_date === 'number', 'link must carry an expiry');
  });

  await check('the subscriber was told, with a join button', () => {
    const sends = callsTo('sendMessage');
    assert.equal(sends.length, 1);
    assert.equal(sends[0].payload.chat_id, 900001);
    const markup = JSON.stringify(sends[0].payload.reply_markup ?? {});
    assert.ok(markup.includes('FAKEINVITE1'), 'the confirmation must carry the invite link');
  });

  /* ── 2. Repeated confirmations are harmless ─────────────── */

  section('Duplicate confirmations');

  const replay = await finalizePayment(firstPayment.reference, { trigger: 'webhook-retry' });
  const replay2 = await finalizePayment(firstPayment.reference, { trigger: 'redirect' });

  await check('a retried webhook reports already_fulfilled', () => {
    assert.equal(replay.outcome, 'already_fulfilled');
    assert.equal(replay2.outcome, 'already_fulfilled');
  });

  await check('no second subscription, link or message is produced', async () => {
    assert.equal(await Subscription.countDocuments({ telegramId: 900001 }), 1);
    assert.equal(await InviteLink.countDocuments({ telegramId: 900001 }), 1);
    assert.equal(callsTo('sendMessage').length, 1);
  });

  await check('concurrent confirmations still fulfil exactly once', async () => {
    const before = callsTo('sendMessage').length;
    await Promise.all([
      finalizePayment(firstPayment.reference, { trigger: 'race-a' }),
      finalizePayment(firstPayment.reference, { trigger: 'race-b' }),
      finalizePayment(firstPayment.reference, { trigger: 'race-c' }),
    ]);
    assert.equal(callsTo('sendMessage').length, before);
    assert.equal(await Subscription.countDocuments({ telegramId: 900001 }), 1);
  });

  /* ── 3. Renewal extends rather than restarts ────────────── */

  section('Renewal');

  const beforeRenewal = await getActiveSubscription(900001);
  const expiryBeforeRenewal = beforeRenewal!.expiresAt;

  // Pretend some reminders already went out this cycle.
  await Subscription.updateOne(
    { _id: beforeRenewal!._id },
    { $set: { 'remindersSent.d7': new Date(), 'remindersSent.d3': new Date() } },
  );

  const { payment: renewalPayment } = await initiatePayment({
    user: subscriber,
    plan: monthly,
    gateway: 'paystack', // FLUTTERWAVE-DISABLED: this renewal used Flutterwave
    email: 'tunde@example.com',
  });

  script.paystackVerify = (reference) => ({
    status: true,
    data: { id: 888, status: 'success', reference, amount: 2_500_000, currency: 'NGN', channel: 'bank' },
  });

  const renewalResult = await finalizePayment(renewalPayment.reference, { trigger: 'test' });

  await check('renewing is recognised as a renewal', () => {
    assert.equal(renewalResult.outcome, 'fulfilled');
    assert.equal(renewalResult.isRenewal, true);
  });

  await check('the end date is extended, never restarted', async () => {
    const sub = await getActiveSubscription(900001);
    const added = (sub!.expiresAt.getTime() - expiryBeforeRenewal.getTime()) / DAY;
    assert.ok(added > 29.9 && added < 30.1, `expected +30 days on top, got ${added}`);
    assert.equal(sub!.renewalCount, 1);
  });

  await check('reminder flags reset so the new cycle warns again', async () => {
    const sub = await getActiveSubscription(900001);
    assert.equal(sub!.remindersSent?.d7, undefined);
    assert.equal(sub!.remindersSent?.d3, undefined);
  });

  await check('the renewal payment is recorded in full', async () => {
    const stored = await Payment.findOne({ reference: renewalPayment.reference });
    assert.equal(stored!.status, 'success');
    assert.equal(stored!.paidAmountMinor, 2_500_000);
  });

  await check('the dormant Flutterwave adapter still converts naira to kobo', async () => {
    // FLUTTERWAVE-DISABLED: the adapter is not registered, but it is kept
    // correct so switching it back on is safe. Flutterwave reports major units.
    const { flutterwaveGateway } = await import('../src/services/payments/flutterwave');
    script.flutterwaveVerify = (reference) => ({
      status: 'success',
      data: { id: 888, tx_ref: reference, amount: 25_000, currency: 'NGN', status: 'successful' },
    });
    const result = await flutterwaveGateway.verify('PTX-dormant-check');
    assert.equal(result.status, 'success');
    assert.equal(result.amountMinor, 2_500_000);
  });

  await check('renewing revokes the old link and issues a new one', async () => {
    const links = await InviteLink.find({ telegramId: 900001 }).sort({ createdAt: 1 });
    assert.equal(links.length, 2);
    assert.equal(links[0].status, 'revoked');
    assert.equal(links[1].status, 'active');
    assert.ok(callsTo('revokeChatInviteLink').length >= 1);
  });

  /* ── 4. Underpayment and failure grant nothing ──────────── */

  section('Rejected payments');

  const shortPayer = await upsertUser({ id: 900002, first_name: 'Ada' });
  const { payment: shortPayment } = await initiatePayment({
    user: shortPayer,
    plan: monthly,
    gateway: 'paystack',
    email: 'ada@example.com',
  });

  script.paystackVerify = (reference) => ({
    status: true,
    data: { id: 999, status: 'success', reference, amount: 1_000_000, currency: 'NGN' },
  });

  const shortResult = await finalizePayment(shortPayment.reference, { trigger: 'test' });

  await check('an underpayment is refused', async () => {
    assert.equal(shortResult.outcome, 'amount_mismatch');
    assert.equal(await Subscription.countDocuments({ telegramId: 900002 }), 0);
    const stored = await Payment.findOne({ reference: shortPayment.reference });
    assert.equal(stored!.status, 'failed');
    assert.equal(stored!.fulfilledAt, null);
  });

  await check('a wrong currency is refused', async () => {
    const { payment } = await initiatePayment({ user: shortPayer, plan: monthly, gateway: 'paystack', email: 'ada@example.com' });
    script.paystackVerify = (reference) => ({
      status: true,
      data: { id: 1000, status: 'success', reference, amount: 2_500_000, currency: 'USD' },
    });
    const result = await finalizePayment(payment.reference, { trigger: 'test' });
    assert.equal(result.outcome, 'amount_mismatch');
    assert.equal(await Subscription.countDocuments({ telegramId: 900002 }), 0);
  });

  await check('a failed charge grants nothing', async () => {
    const { payment } = await initiatePayment({ user: shortPayer, plan: monthly, gateway: 'paystack', email: 'ada@example.com' });
    script.paystackVerify = (reference) => ({
      status: true,
      data: { id: 1001, status: 'failed', reference, amount: 2_500_000, currency: 'NGN', gateway_response: 'Declined' },
    });
    const result = await finalizePayment(payment.reference, { trigger: 'test' });
    assert.equal(result.outcome, 'failed');
    assert.equal(await Subscription.countDocuments({ telegramId: 900002 }), 0);
  });

  await check('a pending payment grants nothing, then succeeds on retry', async () => {
    const waiter = await upsertUser({ id: 900005, first_name: 'Bola' });
    const { payment } = await initiatePayment({ user: waiter, plan: monthly, gateway: 'paystack', email: 'bola@example.com' });

    script.paystackVerify = (reference) => ({
      status: true,
      data: { id: 1010, status: 'ongoing', reference, amount: 2_500_000, currency: 'NGN' },
    });
    const pending = await finalizePayment(payment.reference, { trigger: 'test' });
    assert.equal(pending.outcome, 'pending');
    assert.equal(await Subscription.countDocuments({ telegramId: 900005 }), 0);
    assert.equal((await Payment.findById(payment._id))!.status, 'pending');

    // The bank settles a moment later.
    script.paystackVerify = (reference) => ({
      status: true,
      data: { id: 1010, status: 'success', reference, amount: 2_500_000, currency: 'NGN' },
    });
    const settled = await finalizePayment(payment.reference, { trigger: 'test' });
    assert.equal(settled.outcome, 'fulfilled');

    const stored = await Payment.findById(payment._id);
    assert.equal(stored!.status, 'success');
    assert.equal(stored!.failureReason, undefined, 'a stale failure reason must not survive success');
    assert.equal(await Subscription.countDocuments({ telegramId: 900005, status: 'active' }), 1);
  });

  await check('an abandoned checkout is visible, not invisible', async () => {
    const abandoned = await Payment.countDocuments({ telegramId: 900002, status: { $in: ['failed', 'pending', 'abandoned'] } });
    assert.ok(abandoned >= 3, `expected the failed attempts to be on record, found ${abandoned}`);
  });

  /* ── 5. One active subscription per person ──────────────── */

  section('Data guarantees');

  await check('the unique index blocks a second active subscription', async () => {
    const existing = await getActiveSubscription(900001);
    await assert.rejects(
      () =>
        Subscription.create({
          user: existing!.user,
          telegramId: 900001,
          planSnapshot: snapshotFromPlan(monthly),
          status: 'active',
          startsAt: new Date(),
          expiresAt: addDays(new Date(), 30),
          cycleStartedAt: new Date(),
        }),
      (error: { code?: number }) => error.code === 11000,
    );
  });

  await check('payment references are unique', async () => {
    const existing = await Payment.findOne({ telegramId: 900001 });
    await assert.rejects(
      () => Payment.create({ ...existing!.toObject(), _id: undefined }),
      (error: { code?: number }) => error.code === 11000,
    );
  });

  /* ── 6. Reminders fire once each ────────────────────────── */

  section('Reminders');

  const reminderUser = await upsertUser({ id: 900003, first_name: 'Chidi' });
  const { subscription: reminderSub } = await activateOrExtend({
    user: reminderUser,
    planSnapshot: snapshotFromPlan(monthly),
    planId: monthly._id as never,
    source: 'payment',
  });

  async function setExpiry(msFromNow: number): Promise<void> {
    await Subscription.updateOne({ _id: reminderSub._id }, { $set: { expiresAt: new Date(Date.now() + msFromNow) } });
  }

  await check('the 7-day reminder fires exactly once', async () => {
    await setExpiry(6.5 * DAY);
    const first = await processReminders();
    assert.equal(first.byKey.d7, 1);
    const second = await processReminders();
    assert.equal(second.byKey.d7, 0, 'a second pass must not re-send');
  });

  await check('the 3-day reminder fires exactly once', async () => {
    await setExpiry(2.5 * DAY);
    assert.equal((await processReminders()).byKey.d3, 1);
    assert.equal((await processReminders()).byKey.d3, 0);
  });

  await check('the 24-hour reminder fires exactly once', async () => {
    await setExpiry(0.5 * DAY);
    assert.equal((await processReminders()).byKey.h24, 1);
    assert.equal((await processReminders()).byKey.h24, 0);
  });

  await check('renewing stops the remaining reminders', async () => {
    await setExpiry(0.5 * DAY);
    await activateOrExtend({
      user: reminderUser,
      planSnapshot: snapshotFromPlan(monthly),
      planId: monthly._id as never,
      source: 'payment',
    });
    const sub = await getActiveSubscription(900003);
    assert.ok(sub!.expiresAt.getTime() - Date.now() > 29 * DAY, 'renewal must push the end date out');
    const report = await processReminders();
    assert.equal(report.byKey.d7 + report.byKey.d3 + report.byKey.h24, 0, 'nothing is due after renewing');
  });

  await check('nothing is sent to a subscription outside the 7-day window', async () => {
    await setExpiry(20 * DAY);
    const report = await processReminders();
    assert.equal(report.sent, 0);
  });

  /* ── 7. Expiry removes the member ───────────────────────── */

  section('Expiry and removal');

  const banCallsBefore = callsTo('banChatMember').length;
  await setExpiry(-1 * DAY);
  const expiryReport = await processExpirations();

  await check('an expired member is removed from the group', () => {
    assert.equal(expiryReport.due, 1);
    assert.equal(expiryReport.removed, 1);
    const bans = callsTo('banChatMember');
    assert.equal(bans.length, banCallsBefore + 1);
    assert.equal(bans.at(-1)!.payload.chat_id, -1001234567890);
    assert.equal(bans.at(-1)!.payload.user_id, 900003);
  });

  await check('removal is a kick, not a permanent ban', () => {
    const unban = callsTo('unbanChatMember').at(-1);
    assert.equal(unban?.payload.user_id, 900003);
    assert.equal(unban?.payload.chat_id, -1001234567890);
    // `only_if_banned` must NOT be set: if the ban had not registered yet the
    // unban would no-op and leave the member permanently banned.
    assert.equal(unban?.payload.only_if_banned, undefined);
  });

  await check('the subscription is marked expired and the notice sent', async () => {
    const sub = await Subscription.findById(reminderSub._id);
    assert.equal(sub!.status, 'expired');
    assert.ok(sub!.removedFromGroupAt);
    assert.ok(sub!.removalNoticeSentAt);
    assert.equal(expiryReport.notified, 1);
  });

  await check('outstanding invite links are revoked on expiry', async () => {
    const live = await InviteLink.countDocuments({ telegramId: 900003, status: 'active' });
    assert.equal(live, 0);
  });

  await check('a second pass does not remove anyone twice', async () => {
    const report = await processExpirations();
    assert.equal(report.due, 0);
  });

  await check('a removed member who pays again gets back in', async () => {
    const { payment } = await initiatePayment({ user: reminderUser, plan: monthly, gateway: 'paystack', email: 'chidi@example.com' });
    script.paystackVerify = (reference) => ({
      status: true,
      data: { id: 1002, status: 'success', reference, amount: 2_500_000, currency: 'NGN' },
    });
    const result = await finalizePayment(payment.reference, { trigger: 'test' });
    assert.equal(result.outcome, 'fulfilled');
    assert.equal(result.isRenewal, false, 'a lapsed member starts a fresh period');
    const link = await findUsableLink(900003);
    assert.ok(link, 'a new invite link must be issued');
  });

  /* ── 7b. A once-a-day scheduler is enough ───────────────── */

  section('Daily-cadence scheduler (Vercel Hobby)');

  // Vercel's Hobby plan caps cron at one run per day, fired at any minute
  // within its hour. These replay a 30-day subscription against a scheduler
  // that only ever wakes once every 24 hours, at three different offsets.
  for (const offsetDays of [0.1, 0.5, 0.9]) {
    await check(`all three reminders and the removal land with a daily pass (offset ${offsetDays}d)`, async () => {
      const id = 910000 + Math.round(offsetDays * 10);
      const user = await upsertUser({ id, first_name: `Daily${id}` });
      const start = new Date();

      const { subscription } = await activateOrExtend({
        user,
        planSnapshot: snapshotFromPlan(monthly),
        planId: monthly._id as never,
        source: 'payment',
      });
      const expiresAt = subscription.expiresAt;

      const messagesBefore = callsTo('sendMessage').filter((c) => c.payload.chat_id === id).length;
      const bansBefore = callsTo('banChatMember').filter((c) => c.payload.user_id === id).length;
      const expiryDay = (expiresAt.getTime() - start.getTime()) / DAY;
      let removalDay: number | null = null;

      // One pass every 24 hours, from day `offsetDays` until past expiry.
      for (let day = offsetDays; day <= 32; day += 1) {
        const now = new Date(start.getTime() + day * DAY);

        await processReminders(now);
        await processExpirations(now);

        const banned = callsTo('banChatMember').filter((c) => c.payload.user_id === id).length > bansBefore;
        if (banned && removalDay === null) removalDay = day;
      }

      const after = await Subscription.findById(subscription._id);

      // Every window was hit despite the scheduler only waking once a day.
      assert.ok(after!.remindersSent?.d7, '7-day reminder never fired');
      assert.ok(after!.remindersSent?.d3, '3-day reminder never fired');
      assert.ok(after!.remindersSent?.h24, '24-hour reminder never fired');

      // Exactly four messages to this subscriber: three reminders + the removal
      // notice. Anything more would mean a window fired twice.
      const messages = callsTo('sendMessage').filter((c) => c.payload.chat_id === id).length - messagesBefore;
      assert.equal(messages, 4, `expected 3 reminders + 1 removal notice, got ${messages}`);

      assert.equal(after!.status, 'expired');
      assert.ok(removalDay !== null, 'the member was never removed');
      assert.ok(removalDay! >= expiryDay, `removed on day ${removalDay} but expiry was day ${expiryDay}`);
      assert.ok(removalDay! - expiryDay <= 1, 'removal must land within one daily pass of expiry');

      const bans = callsTo('banChatMember').filter((c) => c.payload.user_id === id).length - bansBefore;
      assert.equal(bans, 1, `removed ${bans} times`);
    });
  }

  await check('a pass that runs out of time reports the backlog and resumes', async () => {
    const ids = [920001, 920002, 920003, 920004];
    for (const id of ids) {
      const user = await upsertUser({ id, first_name: `Backlog${id}` });
      const { subscription } = await activateOrExtend({
        user,
        planSnapshot: snapshotFromPlan(monthly),
        planId: monthly._id as never,
        source: 'payment',
      });
      await Subscription.updateOne({ _id: subscription._id }, { $set: { expiresAt: new Date(Date.now() - DAY) } });
    }

    // A deadline already in the past: the pass must stop immediately rather
    // than running past its host's execution limit.
    const starved = await processExpirations(new Date(), { deadline: Date.now() - 1 });
    assert.equal(starved.due, 0, 'no work is attempted past the deadline');
    assert.ok(starved.remaining >= ids.length, 'the backlog is reported so a follow-up pass is triggered');

    // Now with room to work.
    const full = await processExpirations(new Date());
    assert.ok(full.removed >= ids.length);
    assert.equal(full.remaining, 0, 'nothing is left over');
  });

  await check('the scheduler flags unfinished work for a follow-up pass', async () => {
    const user = await upsertUser({ id: 930001, first_name: 'Chain' });
    const { subscription } = await activateOrExtend({
      user,
      planSnapshot: snapshotFromPlan(monthly),
      planId: monthly._id as never,
      source: 'payment',
    });
    await Subscription.updateOne({ _id: subscription._id }, { $set: { expiresAt: new Date(Date.now() - DAY) } });

    const starved = await runScheduledWork({ budgetMs: 1, includeBroadcast: false });
    assert.equal(starved.hasMoreWork, true, 'an unfinished pass must ask for another');

    const complete = await runScheduledWork({ includeBroadcast: false });
    assert.equal(complete.expiry.remaining, 0);
    assert.equal(complete.hasMoreWork, false, 'a finished pass must not chain forever');
  });

  /* ── 8. Reconciliation safety net ───────────────────────── */

  section('Reconciliation');

  await check('a verified but unfulfilled payment is repaired', async () => {
    const orphan = await upsertUser({ id: 900004, first_name: 'Zainab' });
    const { payment } = await initiatePayment({ user: orphan, plan: monthly, gateway: 'paystack', email: 'z@example.com' });

    // Simulate a crash after verification but before access was granted.
    await Payment.updateOne(
      { _id: payment._id },
      { $set: { status: 'success', paidAmountMinor: 2_500_000, paidCurrency: 'NGN', fulfilledAt: null, fulfilmentLock: null } },
    );
    script.paystackVerify = (reference) => ({
      status: true,
      data: { id: 1003, status: 'success', reference, amount: 2_500_000, currency: 'NGN' },
    });

    assert.equal(await Subscription.countDocuments({ telegramId: 900004 }), 0);
    const repaired = await reconcileUnfulfilledPayments();
    assert.ok(repaired >= 1);
    assert.equal(await Subscription.countDocuments({ telegramId: 900004, status: 'active' }), 1);
    assert.ok(await findUsableLink(900004));
  });

  await check('a missed webhook is settled the moment the subscriber asks', async () => {
    // The scenario a once-a-day scheduler makes painful: the webhook never
    // arrived, so the payment is still "pending" from our side even though the
    // money went through. Opening /status must not wait for the next pass.
    const stranded = await upsertUser({ id: 900006, first_name: 'Ngozi' });
    const { payment } = await initiatePayment({
      user: stranded,
      plan: monthly,
      gateway: 'paystack',
      email: 'ngozi@example.com',
    });

    script.paystackVerify = (reference) => ({
      status: true,
      data: { id: 1200, status: 'success', reference, amount: 2_500_000, currency: 'NGN' },
    });

    assert.equal((await Payment.findById(payment._id))!.status, 'pending');
    assert.equal(await Subscription.countDocuments({ telegramId: 900006 }), 0);

    const healed = await reconcileUserPayments(900006);
    assert.equal(healed?.outcome, 'fulfilled');
    assert.equal(await Subscription.countDocuments({ telegramId: 900006, status: 'active' }), 1);
    assert.ok(await findUsableLink(900006), 'they get their invite link straight away');
  });

  await check('the self-heal costs nothing when there is nothing to fix', async () => {
    const quiet = await upsertUser({ id: 900007, first_name: 'Emeka' });
    assert.equal(await reconcileUserPayments(quiet.telegramId), null);
  });

  /* ── 9. Invite link re-issue ────────────────────────────── */

  section('Invite links');

  await check('re-issuing revokes the previous link', async () => {
    const user = await User.findOne({ telegramId: 900001 });
    const sub = await getActiveSubscription(900001);
    const before = await findUsableLink(900001);
    const fresh = await issueInviteLink({ user: user!, subscription: sub! });

    assert.notEqual(fresh.inviteLink, before!.inviteLink);
    const stale = await InviteLink.findById(before!._id);
    assert.equal(stale!.status, 'revoked');
    assert.equal(await InviteLink.countDocuments({ telegramId: 900001, status: 'active' }), 1);
  });

  await check('a link never outlives the subscription itself', async () => {
    const user = await User.findOne({ telegramId: 900001 });
    const sub = await getActiveSubscription(900001);
    sub!.expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes left
    await sub!.save();

    const link = await issueInviteLink({ user: user!, subscription: sub! });
    assert.ok(link.expiresAt <= sub!.expiresAt, 'link TTL must be clamped to the subscription end');
  });

  /* ── 10. Broadcast ──────────────────────────────────────── */

  section('Broadcast');

  await check('audiences are filtered correctly', async () => {
    const active = await resolveAudience('active');
    const expired = await resolveAudience('expired');
    const all = await resolveAudience('all');

    assert.ok(active.includes(900001), 'an active subscriber belongs to the active audience');
    assert.ok(!expired.includes(900001), 'an active subscriber is not in the expired audience');
    assert.ok(expired.includes(900002) === false, 'someone who never paid is not "expired"');
    assert.ok(all.length >= active.length);
  });

  await check('a broadcast is queued once per recipient and delivered', async () => {
    const copiesBefore = callsTo('copyMessage').length;
    const { broadcast, total } = await createBroadcast({
      createdByTelegramId: 111,
      audience: 'active',
      sourceChatId: 111,
      sourceMessageId: 55,
      preview: 'Market update',
    });

    assert.ok(total > 0);
    assert.equal(await BroadcastTarget.countDocuments({ broadcast: broadcast._id }), total);

    const report = await processBroadcastQueue(9000);
    assert.equal(report.sent, total);

    const finished = await Broadcast.findById(broadcast._id);
    assert.equal(finished!.status, 'done');
    assert.equal(finished!.sent, total);
    assert.equal(finished!.failed, 0);

    // total member copies + one delivery summary to the admin.
    assert.equal(callsTo('copyMessage').length, copiesBefore + total);
  });

  await check('re-running the queue does not re-message anyone', async () => {
    const before = callsTo('copyMessage').length;
    const report = await processBroadcastQueue(3000);
    assert.equal(report.sent, 0);
    assert.equal(callsTo('copyMessage').length, before);
  });

  section('Free month for members of the partner community');

  const trial = await import('../src/services/trial.service');
  const texts = await import('../src/bot/texts');
  const CUTOFF = new Date('2026-08-01T00:00:00+01:00');

  // What Telegram "says" about each person, keyed by telegram id.
  const membershipBook = new Map<number, unknown>();
  let lookups = 0;
  trial.setMembershipLookupForTests(async (chatId, userId) => {
    lookups += 1;
    assert.equal(chatId, -1009999999999, 'must query the source community, not the paid channel');
    return (membershipBook.get(userId) ?? { status: 'not_member' }) as never;
  });
  const member = (joinedAt: Date | null, role = 'member') => ({ status: 'member', joinedAt, role });

  await check('someone who joined after 1 August qualifies', async () => {
    membershipBook.set(940001, member(new Date('2026-08-05T10:00:00Z')));
    const user = await upsertUser({ id: 940001, first_name: 'Aug' });
    const result = await trial.checkTrialEligibility(user);
    assert.equal(result.verdict, 'eligible');
  });

  await check('granting creates a 30-day free subscription with an invite link', async () => {
    const user = (await User.findOne({ telegramId: 940001 }))!;
    const grant = await trial.grantTrial(user, new Date('2026-08-05T10:00:00Z'));
    assert.ok(grant, 'grant should succeed');
    assert.equal(grant!.extendedExisting, false);
    assert.equal(grant!.subscription.source, 'trial');
    assert.equal(grant!.subscription.planSnapshot.priceMinor, 0);
    const days = (grant!.subscription.expiresAt.getTime() - Date.now()) / DAY;
    assert.ok(days > 29.9 && days < 30.1, `expected ~30 days, got ${days}`);
    assert.ok(grant!.inviteLink, 'an invite link must be issued');
    assert.ok((await User.findOne({ telegramId: 940001 }))!.trialClaimedAt);
  });

  await check('the free month can only ever be claimed once', async () => {
    const user = (await User.findOne({ telegramId: 940001 }))!;
    assert.equal((await trial.checkTrialEligibility(user)).verdict, 'already_claimed');
    assert.equal(await trial.grantTrial(user, null), null);
    assert.equal(await Subscription.countDocuments({ telegramId: 940001 }), 1);
  });

  await check('two simultaneous claims produce exactly one free month', async () => {
    membershipBook.set(940002, member(new Date('2026-09-01T00:00:00Z')));
    const user = await upsertUser({ id: 940002, first_name: 'Race' });
    const [a, b, c] = await Promise.all([
      trial.grantTrial(user, null),
      trial.grantTrial(user, null),
      trial.grantTrial(user, null),
    ]);
    assert.equal([a, b, c].filter(Boolean).length, 1);
    assert.equal(await Subscription.countDocuments({ telegramId: 940002 }), 1);
  });

  await check('someone who joined before 1 August does not qualify', async () => {
    membershipBook.set(940003, member(new Date('2026-07-20T00:00:00Z')));
    const user = await upsertUser({ id: 940003, first_name: 'July' });
    assert.equal((await trial.checkTrialEligibility(user)).verdict, 'joined_too_early');
  });

  await check('the cutoff is exact, in Lagos time', async () => {
    membershipBook.set(940004, member(CUTOFF));
    membershipBook.set(940005, member(new Date(CUTOFF.getTime() - 1000)));
    const onTheDot = await upsertUser({ id: 940004, first_name: 'OnTime' });
    const oneSecondEarly = await upsertUser({ id: 940005, first_name: 'Early' });
    assert.equal((await trial.checkTrialEligibility(onTheDot)).verdict, 'eligible');
    assert.equal((await trial.checkTrialEligibility(oneSecondEarly)).verdict, 'joined_too_early');
    // 00:00 Lagos is 23:00 UTC the day before.
    assert.equal(CUTOFF.toISOString(), '2026-07-31T23:00:00.000Z');
  });

  await check('someone who joins the partner community in future still qualifies', async () => {
    membershipBook.set(940006, member(new Date('2027-02-14T09:00:00Z')));
    const user = await upsertUser({ id: 940006, first_name: 'Future' });
    assert.equal((await trial.checkTrialEligibility(user, new Date('2027-02-15T00:00:00Z'))).verdict, 'eligible');
  });

  await check('a non-member does not qualify, and is not re-queried every tap', async () => {
    const user = await upsertUser({ id: 940007, first_name: 'Outsider' });
    const before = lookups;
    const now = new Date();
    assert.equal((await trial.checkTrialEligibility(user, now)).verdict, 'not_member');
    const cached = (await User.findOne({ telegramId: 940007 }))!;
    assert.equal((await trial.checkTrialEligibility(cached, new Date(now.getTime() + 60_000))).verdict, 'not_member');
    assert.equal(lookups, before + 1, 'the second check within 15 minutes must use the cache');
  });

  await check('someone who joins the partner community later is recognised once the cache lapses', async () => {
    const now = new Date();
    membershipBook.set(940007, member(new Date()));
    const cached = (await User.findOne({ telegramId: 940007 }))!;
    const later = new Date(now.getTime() + 16 * 60_000);
    assert.equal((await trial.checkTrialEligibility(cached, later)).verdict, 'eligible');
  });

  await check('a failed lookup is not cached against the person', async () => {
    membershipBook.set(940008, { status: 'error', reason: 'CHAT_ADMIN_REQUIRED' });
    const user = await upsertUser({ id: 940008, first_name: 'Glitch' });
    const result = await trial.checkTrialEligibility(user);
    assert.equal(result.verdict, 'lookup_failed');
    assert.equal(result.reason, 'CHAT_ADMIN_REQUIRED');
    assert.equal((await User.findOne({ telegramId: 940008 }))!.trialCheck?.result, undefined);
  });

  await check('the partner community creator has no join date and does not qualify', async () => {
    membershipBook.set(940009, member(null, 'creator'));
    const user = await upsertUser({ id: 940009, first_name: 'Owner' });
    assert.equal((await trial.checkTrialEligibility(user)).verdict, 'joined_too_early');
  });

  await check('the free month counts from the day they join, not the day they claim', async () => {
    membershipBook.set(940010, member(new Date('2026-09-10T00:00:00Z')));
    const user = await upsertUser({ id: 940010, first_name: 'Slow' });
    await trial.grantTrial(user, null);

    const joinedPaidChannel = new Date(Date.now() + 3 * DAY);
    const started = await trial.startTrialClockOnJoin(940010, joinedPaidChannel);
    assert.ok(started);
    assert.equal(started!.expiresAt.getTime(), addDays(joinedPaidChannel, 30).getTime());

    // Leaving and rejoining must not restart it.
    assert.equal(await trial.startTrialClockOnJoin(940010, new Date(Date.now() + 10 * DAY)), null);
  });

  await check('a paying member who qualifies gets 30 days added, and stays a paying member', async () => {
    membershipBook.set(940011, member(new Date('2026-08-20T00:00:00Z')));
    const user = await upsertUser({ id: 940011, first_name: 'Payer' });
    const { subscription: paid } = await activateOrExtend({
      user,
      planSnapshot: snapshotFromPlan(monthly),
      planId: monthly._id as never,
      source: 'payment',
    });
    const paidUntil = paid.expiresAt;

    const grant = await trial.grantTrial(user, null);
    assert.equal(grant!.extendedExisting, true);
    assert.equal(grant!.subscription.source, 'payment');
    const added = (grant!.subscription.expiresAt.getTime() - paidUntil.getTime()) / DAY;
    assert.ok(added > 29.9 && added < 30.1, `expected +30 days, got ${added}`);
    // Not a trial, so joining the channel must not reset their paid clock.
    assert.equal(await trial.startTrialClockOnJoin(940011, new Date()), null);
  });

  await check('paying during the free month adds a month on top of it', async () => {
    const user = (await User.findOne({ telegramId: 940001 }))!;
    const before = (await getActiveSubscription(940001))!.expiresAt;
    const { subscription } = await activateOrExtend({
      user,
      planSnapshot: snapshotFromPlan(monthly),
      planId: monthly._id as never,
      source: 'payment',
    });
    const added = (subscription.expiresAt.getTime() - before.getTime()) / DAY;
    assert.ok(added > 29.9 && added < 30.1);
    assert.equal(subscription.source, 'payment', 'once paid, it is no longer a trial');
  });

  await check('paying a longer plan during the free month stacks onto it', async () => {
    // The exact scenario: someone on a free month pays for 3 months in advance.
    membershipBook.set(940012, member(new Date('2026-09-02T00:00:00Z')));
    const user = await upsertUser({ id: 940012, first_name: 'Advance' });
    await trial.grantTrial(user, null);
    const trialEnds = (await getActiveSubscription(940012))!.expiresAt;

    const quarterly = { code: 'quarterly', name: '3 Months', priceMinor: 5_500_000, currency: 'NGN', durationDays: 90 };
    const { subscription } = await activateOrExtend({ user, planSnapshot: quarterly, source: 'payment' });

    const added = (subscription.expiresAt.getTime() - trialEnds.getTime()) / DAY;
    assert.ok(added > 89.9 && added < 90.1, `expected the 90 days on top of the free month, got ${added}`);
    assert.equal(subscription.source, 'payment', 'they are now a paying member');

    // And no reminders until the new, later date.
    assert.equal(subscription.remindersSent?.d7, undefined);
    await processReminders(new Date(trialEnds.getTime() - DAY));
    const after = await Subscription.findById(subscription._id);
    assert.equal(after!.remindersSent?.h24, undefined, 'no reminder at the old free-month end date');
    assert.equal(after!.remindersSent?.d3, undefined);
    assert.equal(after!.remindersSent?.d7, undefined);
  });

  await check('free-month reminders and removal speak about the free month', async () => {
    const trialSub = (await getActiveSubscription(940002))!;
    assert.match(texts.reminder7Day(trialSub), /free month/i);
    assert.match(texts.reminder3Day(trialSub), /free month/i);
    assert.match(texts.reminder24Hour(trialSub), /free month/i);
    assert.match(texts.removalNotice(trialSub), /free month/i);
    const paidSub = (await getActiveSubscription(900001))!;
    assert.doesNotMatch(texts.reminder7Day(paidSub), /free month/i);
  });

  section('Full-API lookup against a simulated Telegram');

  const mtproto = await import('../src/services/mtproto');
  const { Api } = await import('telegram');
  const bigInt = (await import('big-integer')).default;
  const { AppSetting } = await import('../src/models/AppSetting');

  const GROUP = -1002182527223;
  const GROUP_ID = bigInt('2182527223');
  const REAL_HASH = bigInt('987654321');
  const calls: string[] = [];

  // Behaves like the real server: a zero channel hash is refused for
  // getParticipant (the production failure), but accepted by getChannels,
  // which hands back the real hash.
  const telegram = {
    channelHash: REAL_HASH,
    minChannel: false,
    members: new Map<number, number>([[950001, Date.UTC(2026, 7, 10) / 1000]]),
    async invoke(request: { className: string } & Record<string, any>) {
      calls.push(request.className);
      if (request.className === 'channels.GetChannels') {
        return {
          chats: [new Api.Channel({ id: GROUP_ID, accessHash: this.channelHash, title: 'Profitable FX Trading Academy',
            photo: new Api.ChatPhotoEmpty(), date: 0, min: this.minChannel })],
        };
      }
      if (request.className === 'users.GetUsers') {
        const id = request.id[0].userId;
        return [new Api.User({ id, accessHash: bigInt(111), firstName: 'x' })];
      }
      if (request.className === 'channels.GetParticipant') {
        if (!request.channel.accessHash.equals(this.channelHash)) throw Object.assign(new Error('x'), { errorMessage: 'CHANNEL_INVALID' });
        if (request.participant.accessHash.isZero()) throw Object.assign(new Error('x'), { errorMessage: 'PARTICIPANT_ID_INVALID' });
        const joined = this.members.get(Number(request.participant.userId));
        if (!joined) throw Object.assign(new Error('x'), { errorMessage: 'USER_NOT_PARTICIPANT' });
        return { participant: new Api.ChannelParticipant({ userId: request.participant.userId, date: joined }) };
      }
      throw new Error(`unexpected ${request.className}`);
    },
  };
  mtproto.setTestClient({ client: telegram, api: Api });

  await check('the group\'s real access hash is fetched first, then used for the lookup', async () => {
    await AppSetting.deleteMany({});
    calls.length = 0;
    const result = await mtproto.lookupMembership(GROUP, 950001);
    assert.equal(result.status, 'member');
    assert.equal((result as { joinedAt: Date }).joinedAt.toISOString(), '2026-08-10T00:00:00.000Z');
    assert.ok(calls.indexOf('channels.GetChannels') < calls.indexOf('channels.GetParticipant'));
  });

  await check('the remembered access hash belongs to this bot only', async () => {
    // Access hashes differ per Telegram account; a different bot must never reuse them.
    const keys = (await AppSetting.find({}).lean()).map((doc) => doc.key);
    assert.ok(keys.includes('mtproto_channel_hash:1234567890:-1002182527223'), `stored under: ${keys.join(', ')}`);
  });

  await check('the access hash is remembered, so later lookups skip that step', async () => {
    calls.length = 0;
    await mtproto.lookupMembership(GROUP, 950001);
    assert.equal(calls.includes('channels.GetChannels'), false);
  });

  await check('a stale remembered hash is replaced automatically', async () => {
    telegram.channelHash = bigInt('555'); // e.g. the bot was removed and re-added
    const result = await mtproto.lookupMembership(GROUP, 950001);
    assert.equal(result.status, 'member');
    telegram.channelHash = REAL_HASH;
    await AppSetting.deleteMany({});
  });

  await check('a real non-member is reported as not a member', async () => {
    assert.deepEqual(await mtproto.lookupMembership(GROUP, 950099), { status: 'not_member' });
  });

  await check('a partial ("min") channel is a clear error, never a silent "not a member"', async () => {
    await AppSetting.deleteMany({});
    telegram.minChannel = true;
    const result = await mtproto.lookupMembership(GROUP, 950001);
    assert.equal(result.status, 'error');
    telegram.minChannel = false;
  });

  await check('a key problem with the person is an error that alerts admins, not "not a member"', async () => {
    const realInvoke = telegram.invoke.bind(telegram);
    telegram.invoke = async (request: { className: string } & Record<string, any>) =>
      request.className === 'users.GetUsers' ? [] : realInvoke(request); // person unresolvable -> zero hash
    const result = await mtproto.lookupMembership(GROUP, 950001);
    telegram.invoke = realInvoke;
    assert.deepEqual(result, { status: 'error', reason: 'PARTICIPANT_ID_INVALID' });
  });

  await check('the step-by-step diagnosis names each stage', async () => {
    const steps = await mtproto.diagnoseLookup(GROUP, 950001);
    assert.deepEqual(steps.map((s) => s.ok), [true, true, true, true]);
    assert.match(steps[3].detail, /joined 2026-08-10/);
  });

  mtproto.setTestClient(null);

  section('Multi-month plans are tracked to the exact day');

  // The worry: someone pays for 3 months and gets reminders after one.
  for (const [label, days] of [['1 Month', 30], ['3 Months', 90], ['6 Months', 180], ['1 Year', 365]] as const) {
    await check(`a ${label} plan reminds only near its real end date`, async () => {
      const id = 960000 + days;
      const buyer = await upsertUser({ id, first_name: label.replace(' ', '') });
      const start = new Date();
      const { subscription } = await activateOrExtend({
        user: buyer,
        planSnapshot: { code: 'x', name: label, priceMinor: 1, currency: 'NGN', durationDays: days },
        source: 'payment',
      });

      // The end date is exactly the plan length away, to the day.
      assert.equal(subscription.expiresAt.getTime(), addDays(start, days).getTime());

      const messagesTo = () => callsTo('sendMessage').filter((c) => c.payload.chat_id === id).length;
      const expiry = subscription.expiresAt.getTime();
      const at = (ms: number) => new Date(ms);

      // A month in (for anything longer than a month), nothing should be sent.
      if (days > 30) {
        const before = messagesTo();
        await processReminders(addDays(start, 30));
        assert.equal(messagesTo(), before, `a ${label} subscriber must hear nothing at day 30`);
      }

      // Halfway through: still nothing.
      const beforeHalf = messagesTo();
      await processReminders(at(start.getTime() + (expiry - start.getTime()) / 2));
      assert.equal(messagesTo(), beforeHalf, 'nothing halfway through');

      // Then the three reminders, each counted from the real end date.
      await processReminders(at(expiry - 6 * DAY));
      await processReminders(at(expiry - 2 * DAY));
      await processReminders(at(expiry - 12 * 60 * 60 * 1000));
      const sub = await Subscription.findById(subscription._id);
      assert.ok(sub!.remindersSent?.d7 && sub!.remindersSent?.d3 && sub!.remindersSent?.h24, 'all three reminders');

      // And removal only after the end date has actually passed.
      // Scoped to this subscriber: a pass dated months ahead legitimately
      // expires other fixtures, so a global count would prove nothing.
      await processExpirations(at(expiry - 60_000));
      assert.equal(
        (await Subscription.findById(subscription._id))!.status,
        'active',
        'must not be removed one minute before their end date',
      );
      await processExpirations(at(expiry + 60_000));
      assert.equal((await Subscription.findById(subscription._id))!.status, 'expired');
    });
  }

  await check('paying for 3 months twice gives six months, not three', async () => {
    const buyer = await upsertUser({ id: 970001, first_name: 'Stacker' });
    const quarter = { code: 'quarterly', name: '3 Months', priceMinor: 5_500_000, currency: 'NGN', durationDays: 90 };
    const first = await activateOrExtend({ user: buyer, planSnapshot: quarter, source: 'payment' });
    const second = await activateOrExtend({ user: buyer, planSnapshot: quarter, source: 'payment' });
    const total = (second.subscription.expiresAt.getTime() - Date.now()) / DAY;
    assert.ok(total > 179.9 && total < 180.1, `expected ~180 days, got ${total}`);
    assert.ok(second.subscription.expiresAt > first.subscription.expiresAt);
  });

  await check('the catalogue syncs to the configured prices, with one badge', async () => {
    const { syncPlans, DEFAULT_PLANS } = await import('../src/services/plan-seed');
    await syncPlans();
    const plans = await Plan.find({ code: { $in: DEFAULT_PLANS.map((p) => p.code) } }).sort({ sortOrder: 1 }).lean();
    assert.deepEqual(
      plans.map((p) => [p.name, p.priceMinor, p.durationDays]),
      [['1 Month', 2_000_000, 30], ['3 Months', 5_500_000, 90], ['6 Months', 10_000_000, 180], ['1 Year', 19_000_000, 365]],
    );
    const badged = plans.filter((p) => p.badge);
    assert.equal(badged.length, 1, 'exactly one plan carries a badge');
    assert.equal(badged[0].code, 'quarterly');
    assert.equal(badged[0].badge, 'Most Popular');
  });

  await check('syncing again changes nothing, and never moves an existing end date', async () => {
    const before = (await getActiveSubscription(970001))!.expiresAt.getTime();
    const changes = await (await import('../src/services/plan-seed')).syncPlans();
    assert.deepEqual(changes.map((c) => c.action), ['unchanged', 'unchanged', 'unchanged', 'unchanged']);
    assert.equal((await getActiveSubscription(970001))!.expiresAt.getTime(), before);
  });

  section('An unfinished payment');

  await check('an abandoned checkout reads as "not completed", never as failed', async () => {
    const shopper = await upsertUser({ id: 980001, first_name: 'Browser' });
    // Read the plan back: an earlier test re-priced it, and the payment must be
    // verified against the price actually charged.
    const current = (await Plan.findById(monthly._id))!;
    const { payment } = await initiatePayment({ user: shopper, plan: current, gateway: 'paystack', email: 'b@example.com' });

    // Exactly what Paystack returns for a checkout nobody completed.
    script.paystackVerify = (reference) => ({
      status: true,
      data: { id: 2001, status: 'abandoned', reference, amount: current.priceMinor, currency: 'NGN' },
    });

    const result = await finalizePayment(payment.reference, { trigger: 'button' });
    assert.equal(result.outcome, 'pending', 'an unfinished payment is not a failure');
    assert.equal(await Subscription.countDocuments({ telegramId: 980001 }), 0, 'and grants nothing');

    // The checkout link must survive, so they can be offered "Pay Now" again.
    const stored = await Payment.findById(payment._id);
    assert.equal(stored!.status, 'pending');
    assert.ok(stored!.checkoutUrl, 'the checkout link is kept so the payment can be finished');

    // Finishing it later still works.
    script.paystackVerify = (reference) => ({
      status: true,
      data: { id: 2001, status: 'success', reference, amount: current.priceMinor, currency: 'NGN' },
    });
    assert.equal((await finalizePayment(payment.reference, { trigger: 'button' })).outcome, 'fulfilled');
    assert.equal(await Subscription.countDocuments({ telegramId: 980001, status: 'active' }), 1);
  });

  await check('a genuinely declined card is still reported as failed', async () => {
    const payer = await upsertUser({ id: 980002, first_name: 'Declined' });
    const declinedPlan = (await Plan.findById(monthly._id))!;
    const { payment } = await initiatePayment({ user: payer, plan: declinedPlan, gateway: 'paystack', email: 'd@example.com' });
    script.paystackVerify = (reference) => ({
      status: true,
      data: { id: 2002, status: 'failed', reference, amount: declinedPlan.priceMinor, currency: 'NGN', gateway_response: 'Declined' },
    });
    const result = await finalizePayment(payment.reference, { trigger: 'button' });
    assert.equal(result.outcome, 'failed');
    assert.equal(result.reason, 'Declined');
  });

  section('A webhook that never arrives');

  await check('a paid bank transfer with no webhook is rescued by the sweep', async () => {
    // The real incident: Paystack said success, our record said pending, and
    // nothing ever asked again. The subscriber paid and got nothing.
    const payer = await upsertUser({ id: 990001, first_name: 'Transfer' });
    const plan = (await Plan.findById(monthly._id))!;
    const { payment } = await initiatePayment({ user: payer, plan, gateway: 'paystack', email: 't@example.com' });

    // Money arrives at the bank, but no webhook reaches us.
    script.paystackVerify = (reference) => ({
      status: true,
      data: {
        id: 6677202811, status: 'success', reference, channel: 'bank_transfer',
        // Paystack reports the amount actually received, fees included.
        amount: plan.priceMinor + 55_838, currency: 'NGN', paid_at: new Date().toISOString(),
      },
    });

    assert.equal((await Payment.findById(payment._id))!.status, 'pending');
    assert.equal(await Subscription.countDocuments({ telegramId: 990001 }), 0);

    const sweep = await reconcilePendingPayments();
    assert.ok(sweep.rescued >= 1, 'the sweep must rescue it');

    const settled = await Payment.findById(payment._id);
    assert.equal(settled!.status, 'success');
    assert.ok(settled!.fulfilledAt, 'and fulfil it');
    assert.equal(await Subscription.countDocuments({ telegramId: 990001, status: 'active' }), 1);
    assert.ok(await findUsableLink(990001), 'with an invite link');
  });

  await check('the sweep never grants the same payment twice', async () => {
    const before = await Subscription.countDocuments({ telegramId: 990001 });
    await reconcilePendingPayments();
    await reconcilePendingPayments();
    assert.equal(await Subscription.countDocuments({ telegramId: 990001 }), before);
  });

  await check('a subscriber returning days later is rescued the moment they ask', async () => {
    const payer = await upsertUser({ id: 990002, first_name: 'ThreeDaysLater' });
    const plan = (await Plan.findById(monthly._id))!;
    const { payment } = await initiatePayment({ user: payer, plan, gateway: 'paystack', email: 'l@example.com' });

    // Backdate it three days — the old 12-hour lookback would have missed this.
    // Via the raw collection: Mongoose makes `createdAt` immutable, so a normal
    // update is silently ignored and the test would prove nothing.
    await Payment.collection.updateOne(
      { _id: payment._id as never },
      { $set: { createdAt: new Date(Date.now() - 3 * DAY) } },
    );
    script.paystackVerify = (reference) => ({
      status: true,
      data: { id: 777001, status: 'success', reference, amount: plan.priceMinor, currency: 'NGN' },
    });

    const result = await reconcileUserPayments(990002);
    assert.equal(result?.outcome, 'fulfilled');
    assert.equal(await Subscription.countDocuments({ telegramId: 990002, status: 'active' }), 1);
  });

  await check('an abandoned checkout is written off, and stops being re-checked', async () => {
    const browser = await upsertUser({ id: 990003, first_name: 'Abandoner' });
    const plan = (await Plan.findById(monthly._id))!;
    const { payment } = await initiatePayment({ user: browser, plan, gateway: 'paystack', email: 'a@example.com' });
    await Payment.collection.updateOne(
      { _id: payment._id as never },
      { $set: { createdAt: new Date(Date.now() - 7 * 60 * 60 * 1000) } },
    );

    script.paystackVerify = (reference) => ({
      status: true,
      data: { id: 777002, status: 'abandoned', reference, amount: plan.priceMinor, currency: 'NGN' },
    });

    await finalizePayment(payment.reference, { trigger: 'test' });
    assert.equal((await Payment.findById(payment._id))!.status, 'abandoned');
    assert.equal(await Subscription.countDocuments({ telegramId: 990003 }), 0, 'and grants nothing');

    const sweep = await reconcilePendingPayments();
    assert.equal(sweep.checked, 0, 'a written-off checkout is not swept again');
  });

  await check('someone who pays after we wrote the checkout off still gets access', async () => {
    const plan = (await Plan.findById(monthly._id))!;
    const stale = await Payment.findOne({ telegramId: 990003 });
    script.paystackVerify = (reference) => ({
      status: true,
      data: { id: 777003, status: 'success', reference, amount: plan.priceMinor, currency: 'NGN' },
    });
    const result = await reconcileUserPayments(990003);
    assert.equal(result?.outcome, 'fulfilled', `late payment on ${stale!.reference} must still be honoured`);
    assert.equal(await Subscription.countDocuments({ telegramId: 990003, status: 'active' }), 1);
  });

  section('Members with emoji in their names');

  await check('an emoji name still gets an invite link, and a valid one', async () => {
    // "Godwin Rosemary 🐈‍⬛🍅 Chinaza 🐈‍⬛" could not be given a link at all:
    // the 32-character cut split an emoji and Telegram rejected the request.
    const user = await upsertUser({ id: 991001, first_name: 'Godwin Rosemary \u{1F408}‍⬛\u{1F345} Chinaza \u{1F408}‍⬛' });
    const { subscription } = await activateOrExtend({
      user,
      planSnapshot: snapshotFromPlan((await Plan.findById(monthly._id))!),
      source: 'manual',
    });

    const link = await issueInviteLink({ user, subscription });
    assert.ok(link, 'a link must be issued');

    const sent = callsTo('createChatInviteLink').at(-1)!;
    const label = String(sent.payload.name);
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    assert.doesNotMatch(label, lone, `half a character reached Telegram: ${JSON.stringify(label)}`);
    assert.ok(Array.from(label).length <= 32, 'and it must fit the 32-character limit');
  });

  await check('every real member name that broke production now works', async () => {
    const names = [
      'Adeniyioluwatosin \u{1F345}\u{1F434}\u{1F469}‍\u{1F4BB}\u{1F410}\u{1F986}\u{1F331}SEED\u{1F40D} Oluwatosin',
      'Nwonumaru Okechukwu Destiny\u{1F345}\u{1F345}\u{1F410}',
      '\u{1F345}\u{1F331} $X \u{1F47E} BITS Ⓜ️ MEMES \u{1F43E} \u{1F345} \u{1F356} Meshchain.Ai \u{1F199} UXUY',
    ];
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

    for (const [index, first_name] of names.entries()) {
      const user = await upsertUser({ id: 991100 + index, first_name });
      const { subscription } = await activateOrExtend({
        user,
        planSnapshot: snapshotFromPlan((await Plan.findById(monthly._id))!),
        source: 'manual',
      });
      assert.ok(await issueInviteLink({ user, subscription }), `no link for ${first_name}`);
      assert.doesNotMatch(String(callsTo('createChatInviteLink').at(-1)!.payload.name), lone);
    }
  });

  await check('a name Telegram refuses falls back to a plain label, never no link', async () => {
    // Belt and braces: whatever Telegram dislikes about a label, the member
    // must still get their link.
    const { createSingleUseInviteLink } = await import('../src/services/telegram');
    let attempts = 0;
    const realInvoke = telegramStub.onCreateInviteLink;
    telegramStub.onCreateInviteLink = () => {
      attempts += 1;
      if (attempts === 1) throw new GrammyError('Bad Request: strings must be encoded in UTF-8',
        { ok: false, error_code: 400, description: 'Bad Request: strings must be encoded in UTF-8' } as never,
        'createChatInviteLink', {} as never);
      return undefined;
    };

    const link = await createSingleUseInviteLink('whatever Telegram dislikes', new Date(Date.now() + 3600_000), 'sub 12345');
    assert.ok(link.invite_link, 'the fallback must still produce a link');
    assert.equal(attempts, 2, 'it should retry exactly once');
    assert.equal(String(callsTo('createChatInviteLink').at(-1)!.payload.name), 'sub 12345');

    telegramStub.onCreateInviteLink = realInvoke;
  });

  section('Choosing where to post');

  const chats = await import('../src/services/chats.service');
  const { ManagedChat } = await import('../src/models');

  await check('a channel counts as postable only with Post Messages', async () => {
    await ManagedChat.deleteMany({});
    await chats.rememberChat({ id: -1005550001, type: 'channel', title: 'Announcements' }, 'administrator', {
      can_post_messages: true,
    });
    await chats.rememberChat({ id: -1005550002, type: 'channel', title: 'Read Only' }, 'administrator', {});
    assert.equal((await ManagedChat.findOne({ chatId: -1005550001 }))!.canPost, true);
    assert.equal((await ManagedChat.findOne({ chatId: -1005550002 }))!.canPost, false);
  });

  await check('an admin in a group can post; a plain member cannot', async () => {
    await chats.rememberChat({ id: -1005550003, type: 'supergroup', title: 'Team' }, 'administrator');
    await chats.rememberChat({ id: -1005550004, type: 'supergroup', title: 'Lurking' }, 'member');
    assert.equal((await ManagedChat.findOne({ chatId: -1005550003 }))!.canPost, true);
    assert.equal((await ManagedChat.findOne({ chatId: -1005550004 }))!.canPost, false);
  });

  await check('losing admin rights removes a chat from the list', async () => {
    await chats.rememberChat({ id: -1005550003, type: 'supergroup', title: 'Team' }, 'left');
    assert.equal((await ManagedChat.findOne({ chatId: -1005550003 }))!.canPost, false);
    const postable = await chats.listPostableChats();
    assert.equal(postable.some((c) => c.chatId === -1005550003), false);
  });

  await check('the paid channel and the free-month source are found and labelled', async () => {
    await ManagedChat.deleteMany({});
    const postable = await chats.listPostableChats();
    const paid = postable.find((c) => c.chatId === -1001234567890);
    const source = postable.find((c) => c.chatId === -1009999999999);

    assert.ok(paid, 'the paid channel must be offered');
    assert.equal(paid!.title, 'PFT VIP Signals.');
    assert.equal(paid!.role, 'paid');

    assert.ok(source, 'the other chat must be offered too');
    assert.equal(source!.title, 'Profitable FX Trading Academy');
    assert.equal(source!.role, 'trial-source');
  });

  section('Plan seeding from the setup link');

  await check('an existing catalogue is left completely alone', async () => {
    const { seedIfCatalogueEmpty } = await import('../src/services/plan-seed');
    await Plan.updateOne({ code: 'monthly' }, { $set: { priceMinor: 3_333_300 } });
    assert.deepEqual(await seedIfCatalogueEmpty(), []);
    assert.equal((await Plan.findOne({ code: 'monthly' }))!.priceMinor, 3_333_300, 'an edited price must survive');
  });

  await check('an empty catalogue gets the starter plans, once', async () => {
    const { seedIfCatalogueEmpty } = await import('../src/services/plan-seed');
    await Plan.deleteMany({});
    assert.deepEqual((await seedIfCatalogueEmpty()).sort(), ['biannual', 'monthly', 'quarterly', 'yearly']);
    assert.deepEqual(await seedIfCatalogueEmpty(), [], 'opening the setup link twice must not duplicate');
    assert.equal(await Plan.countDocuments({}), 4);
  });

  /* ── Done ───────────────────────────────────────────────── */

  await disconnectFromDatabase();
  await mongo.stop();

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
