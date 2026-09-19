# Profitex — Telegram Subscription Bot

Automates the full subscription lifecycle for **Profitable Forex Trading Academy**:
takes payment, issues a one-time invite link, tracks expiry, reminds members at
7 days / 3 days / 24 hours, and removes them automatically when they lapse.

Built to the Profitex PRD (September 2026).

---

## What it does

| Area | Behaviour |
| --- | --- |
| **Payments** | Paystack and Flutterwave checkout, created from inside the bot. Every payment is confirmed by calling the gateway directly — never by trusting a redirect, a webhook body or a screenshot. |
| **Duplicate protection** | A retried webhook, a refreshed redirect and the "I have paid" button all funnel through one code path guarded by two database-level locks. A payment can only ever produce one subscription. |
| **Access** | A single-use invite link (`member_limit: 1`) with its own expiry, issued per payment and revoked as soon as a newer one is minted. The group's own shared link should stay off, so a completed payment is the only way in. |
| **Renewals** | Renewing before expiry **extends** the end date rather than restarting it, and clears the reminder flags so the new cycle warns again. |
| **Expiry** | A scheduled pass removes anyone past their end date (ban + immediate unban, so they can rejoin after paying), revokes their links and tells them why. |
| **Reminders** | 7-day, 3-day and 24-hour notices, each sent once per cycle, each carrying a renewal button. |
| **Messaging** | Post to the group, throttled broadcasts to all / active / expired members with a delivery summary, and one-to-one DMs — all from Telegram. |
| **Admin** | Member list, member cards, payment history, plan management (add / rename / reprice / retire), manual grant and revoke — no developer needed, no web dashboard. |

---

## Technology

- **Node.js 20+** and **TypeScript** (strict)
- **grammY** for every Telegram interaction
- **MongoDB** (Atlas) via Mongoose
- **Express** for the Telegram webhook, both payment webhooks, the checkout redirect and the cron endpoint
- **node-cron** for the scheduled worker on always-on hosts; **Vercel Cron**, **GitHub Actions** or any external scheduler hitting `/api/cron/run` on serverless

---

## Project structure

```
src/
  config/env.ts            Validated environment (zod). Fails fast and explains why.
  db/connect.ts            Cached Mongoose connection (serverless friendly).
  models/                  User, Plan, Subscription, Payment, InviteLink,
                           Broadcast + BroadcastTarget, BotSession, ActivityLog.
  services/
    telegram.ts            Telegram calls with 429/retry_after handling,
                           invite-link creation, member removal.
    payments/
      paystack.ts          Checkout, verification, HMAC-SHA512 webhook signature.
      flutterwave.ts       Checkout, verification, verif-hash webhook check.
      index.ts             Registry of the gateways that are actually configured.
    payment.service.ts     initiate → verify → fulfil exactly once → reconcile.
    subscription.service.ts  Activate / extend / expire / revoke. One active
                           subscription per person, enforced by a unique index.
    invite.service.ts      Issue, revoke, match on join, expire stale links.
    broadcast.service.ts   Audience resolution, per-recipient queue, rate limiting.
    notify.service.ts      Every outbound subscriber message.
    user.service.ts        Upsert, search, admin checks, reachability.
    dispatch.ts            Kicks the broadcast worker (in-process or via self-call).
  jobs/
    reminders.ts           Which reminder is due, read from the end date.
    expiry.ts              Remove, revoke, notify. Batched and resumable.
    scheduler.ts           One time-budgeted maintenance pass; each step
                           isolated, each resumable, reporting leftover work.
  bot/
    index.ts               Composes middleware and handlers; error handling.
    context.ts             Session shape.
    session-storage.ts     grammY sessions persisted in MongoDB.
    middlewares.ts         DB, user attachment, admin gate, callback answering.
    texts.ts               All subscriber-facing copy, in one place.
    keyboards.ts           All inline keyboards and the callback-data scheme.
    handlers/              start, plans + checkout, account, group membership.
    admin/                 reports, plans, messaging, access, command router.
  http/app.ts              Every HTTP route.
  index.ts                 Standalone entry point (polling or webhook + cron).
api/index.ts               Vercel serverless entry point.
scripts/                   seed, doctor, set-webhook, find-group-id, cron,
                           simulate-expiry.
tests/                     Offline smoke test + full lifecycle integration test.
```

---

## Getting started locally

```bash
npm install
cp .env.example .env.local  # then fill it in — see DEPLOYMENT.md
npm run setup-bot           # bot description, blurb and command menu
npm run find-group-id       # if you don't know GROUP_CHAT_ID yet
npm run seed                # create the starter plans
npm run doctor              # pre-flight check: env, DB, group rights, gateways
npm run dev                 # long polling, no public URL needed
```

Configuration is read from `.env.local` first, then `.env`. Both are
git-ignored, as is `.env.example` — [DEPLOYMENT.md](DEPLOYMENT.md#environment-variables)
holds the authoritative variable reference. A variable that is present but blank
counts as unset, so a half-filled file never brings the whole config down.

Payments need a public HTTPS URL for the gateway redirect and webhooks. For
local testing run `ngrok http 3000` and set `PUBLIC_URL` to the ngrok URL.

### Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Long polling with hot reload |
| `npm run build` / `npm start` | Compile, then run the compiled bot |
| `npm run doctor` | Pre-flight check — run this whenever something breaks |
| `npm run find-group-id` | Prints the id of any group the bot is in |
| `npm run setup-bot` | Sets the bot's description, profile blurb and command menu |
| `npm run seed` | Creates the starter plans (safe to re-run) |
| `npm run set-webhook` | Points Telegram at `PUBLIC_URL/api/telegram` |
| `npm run delete-webhook` | Removes it (required before long polling) |
| `npm run cron` | Runs one maintenance pass and prints the report |
| `npm run simulate-expiry <id> <days>` | Moves someone's end date to test reminders/removal |
| `npm test` | Smoke test + full lifecycle integration test |

---

## HTTP endpoints

| Route | Purpose |
| --- | --- |
| `GET /health` | Liveness check |
| `POST /api/telegram` | Telegram webhook (verifies `X-Telegram-Bot-Api-Secret-Token`) |
| `POST /api/webhooks/paystack` | Paystack webhook (verifies HMAC-SHA512 over the raw body) |
| `POST /api/webhooks/flutterwave` | Flutterwave webhook (verifies the `verif-hash` header) |
| `GET /api/payment/callback` | Browser redirect after checkout; verifies, then bounces back into Telegram |
| `GET\|POST /api/cron/run` | Maintenance pass. Requires `CRON_SECRET` via `x-cron-secret`, `Authorization: Bearer …`, or `?secret=` |

---

## How the scheduler survives a once-a-day cron

Vercel's Hobby plan allows exactly one cron run per day. Three properties of the
design make that enough:

1. **Reminder windows are ranges.** Each pass asks "is this subscription inside
   the 7-day / 3-day / 24-hour window *now*", not "is it exactly 7 days out". A
   scheduler waking once every 24 hours still lands inside every window — proven
   by replaying a full 30-day subscription against a daily pass at three
   different times of day.

2. **Passes are time-budgeted and resumable.** Work stops cleanly at
   `SCHEDULER_BUDGET_MS`, reports what is left, and starts a **follow-up pass in
   a fresh invocation** before responding. One trigger fans out into as many
   invocations as the backlog needs, capped by `MAX_SCHEDULER_CHAIN`.

3. **Access never waits for cron.** Payment confirmation comes from the gateway
   webhook. If one is ever missed, `/status` and `/link` re-verify that
   subscriber's own recent payments on the spot.

The only real cost of a daily cadence is that an expired member can linger in the
group for up to 24 hours. Pointing any free external pinger at `/api/cron/run?async=1` drops that to 15
minutes — see [DEPLOYMENT.md](DEPLOYMENT.md#removals-within-30-minutes-still-free).

## Tests

```bash
npm test
```

- **`tests/smoke.ts`** — no database, no network: money arithmetic in minor units,
  reminder bucket boundaries, reference generation, Paystack HMAC verification
  (including a tampered body), Flutterwave `verif-hash`, webhook event filtering,
  and every HTTP route's auth behaviour.
- **`tests/integration.ts`** — a real in-memory MongoDB with Telegram stubbed via a
  grammY API transformer and the gateways stubbed at the fetch layer. Covers the
  full lifecycle: first payment, duplicate and concurrent confirmations, renewal
  extension, underpayment and wrong-currency rejection, the unique-index
  guarantee, each reminder firing exactly once, expiry removal, rejoin after
  expiry, crash reconciliation, invite-link re-issue and the broadcast queue.

---

## Going live

No domain purchase is required — Vercel's free `*.vercel.app` HTTPS URL satisfies
Telegram and both payment gateways. See
**[DEPLOYMENT.md](DEPLOYMENT.md)** for the full step-by-step.
See **[ADMIN_GUIDE.md](ADMIN_GUIDE.md)** for the Profitex team's day-to-day guide.
