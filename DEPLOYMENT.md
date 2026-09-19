# Going Live — Step by Step

Nothing here needs more than copy-paste plus a few clicks. Budget about 45
minutes the first time.

At the end of every major step there is a **✅ Check** — run it before moving on.

---

## 0. Before you start

You need:

- A Telegram account (yours will be the first admin)
- The private Telegram group for the academy
- A MongoDB Atlas account — free tier is fine
- A Paystack account and a Flutterwave account
- A place to run the bot (see [Step 6](#6-deploy))
- Node.js 20 or newer installed locally

### What actually depends on what

The steps below are numbered for readability, **not** because the order is
fixed. Most of them are independent, so do them in whatever order suits you.
There are only four real constraints:

| This… | …must come before this | Why |
| --- | --- | --- |
| Creating the bot ([1](#1-create-the-bot)) | Reading the group id ([2c](#2c-get-the-group-id)) | `find-group-id` signs in *as your bot* to see the group |
| Converting to a supergroup ([2a](#2a-it-must-be-a-supergroup)) | Reading the group id ([2c](#2c-get-the-group-id)) | Converting **changes the id** — read it first and you store a dead one |
| The first deploy ([6](#6-deploy)) | Setting `PUBLIC_URL` | You cannot know `<project>.vercel.app` until the project exists |
| `PUBLIC_URL` + bot token | Registering webhooks ([7](#7-point-the-gateways-at-your-deployment)) | All three webhook URLs are built from it |

Everything else — MongoDB Atlas ([3](#3-mongodb-atlas)), the Paystack and
Flutterwave keys ([4](#4-paystack), [5](#5-flutterwave)), pushing to GitHub,
and seeding the plans ([8](#8-create-the-plans)) — can happen at any point.

### Two things that surprise people

**You will set environment variables in at least two passes.** `PUBLIC_URL` does
not exist until after the first deploy, so "fill in every variable, then deploy"
is impossible for anyone. Plan for: deploy once to learn the URL → set all the
variables → redeploy.

**Vercel needs a redeploy for environment variables to take effect.** Changes are
[never applied to existing deployments](https://vercel.com/docs/environment-variables/managing-environment-variables).
This is the only reason this guide gathers credentials before deploying — to
spend one redeploy instead of five. Deploying earlier is perfectly safe: the
build succeeds and the URL simply returns `500` until the variables are set.
Just do not point Telegram or the gateways at it until it is configured.

### If you would rather set up the infrastructure first

That works. This order has the same number of redeploys:

1. MongoDB Atlas → `MONGODB_URI`
2. Paystack and Flutterwave keys
3. BotFather → `BOT_TOKEN` and your admin id *(two minutes; do it before the
   env-var step so the form can be filled in one go)*
4. The group → `GROUP_CHAT_ID`
5. Push to GitHub
6. `vercel link && vercel --prod` → learn the URL (it will 500 — expected)
7. Set **all** environment variables including `PUBLIC_URL`, then redeploy
8. Register the webhooks, seed the plans, run `npm run doctor`

---

## 1. Create the bot

1. Open Telegram and message [@BotFather](https://t.me/BotFather).
2. Send `/newbot`. Give it a display name (`Profitex Academy`) and a username
   ending in `bot` (`profitex_academy_bot`).
3. BotFather replies with a token like `8123456789:AAH...`. **Copy it** — this is
   `BOT_TOKEN`. Treat it like a password.
4. While you are there, set `/setuserpic` to the Profitex logo and
   `/setprivacy` → **Enable** (the bot has no reason to read group chatter).

5. The description, the profile blurb and the command menu are scripted, so you
   do not have to type them into BotFather. Once `BOT_TOKEN` is in
   `.env.local`:

   ```bash
   npm run setup-bot
   ```

   Edit the copy at the top of [`scripts/setup-bot-profile.ts`](scripts/setup-bot-profile.ts)
   and re-run to change any of it — the script checks Telegram's length limits
   (120 characters for the profile blurb, 512 for the description) before
   sending, and prints back exactly what is live.

   Re-run this **after** filling in `ADMIN_TELEGRAM_IDS`, so each admin gets the
   extra command menu. It is also the only thing that publishes the command list
   on a serverless deployment, which never boots a long-lived process.

Now get **your own** Telegram user id: message [@userinfobot](https://t.me/userinfobot).
It replies with a number like `5123456789`. That is `ADMIN_TELEGRAM_IDS`.

> Add every Profitex team member who needs admin access, comma separated:
> `ADMIN_TELEGRAM_IDS=5123456789,6234567890`

---

## 2. Prepare the group

### 2a. It must be a supergroup

Telegram's Bot API can only remove members from a **supergroup**. Most active
groups already are one. To be sure — and to convert a basic group if it is not —
open the group → **Edit** → **Chat history for new members** and switch it to
**Hidden**, then back if you prefer. That conversion changes the group's id, so
do it *before* step 2c.

### 2b. Add the bot as an administrator

Group → **Members** → **Add Member** → search your bot → add it.
Then **Administrators** → **Add Admin** → select the bot and switch **on**:

- ✅ **Invite Users via Link** — required to create the single-use links
- ✅ **Ban Users** — required to remove expired members
- ✅ **Delete Messages** and **Manage Messages** — needed for `/post`

Leave the rest off.

### 2c. Get the group id

```bash
npm install
cp .env.example .env.local     # .env also works; .env.local wins if both exist
# put BOT_TOKEN into .env.local, then:
npm run find-group-id
```

Send any message in the group. The script prints:

```
──────────────────────────────────────────────────
  Title : Profitable Forex Trading Academy
  Type  : supergroup
  ID    : -1001234567890
──────────────────────────────────────────────────
```

Copy that into `GROUP_CHAT_ID` and press `Ctrl+C`.

> If it says `Type : group`, it is not a supergroup yet — go back to step 2a.

### 2d. Turn off the shared invite link

Group → **Edit** → **Invite Links** → open the primary link → **Revoke**.

This is the point of the whole system: once the shared link is gone, the only way
into the group is a link the bot issued against a confirmed payment.

**✅ Check:** the group is a supergroup, the bot is an admin with invite + ban
rights, and you have the negative `-100…` id.

---

## 3. MongoDB Atlas

1. [cloud.mongodb.com](https://cloud.mongodb.com) → **Create** a free **M0** cluster.
   Pick the region closest to your users (e.g. `eu-west-1` or `af-south-1`).
2. **Database Access** → **Add New Database User**. Username `profitex`, and use
   **Autogenerate Secure Password** — copy it somewhere safe. Role:
   **Read and write to any database**.
3. **Network Access** → **Add IP Address** → **Allow Access from Anywhere**
   (`0.0.0.0/0`). Serverless and most PaaS hosts have no fixed outbound IP, so
   this is required. The database is still protected by the username and password.
4. **Database** → **Connect** → **Drivers** → **Node.js**. Copy the string:

   ```
   mongodb+srv://profitex:<password>@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority
   ```

   Replace `<password>` with the real password. If it contains `@ : / ? # [ ] %`,
   URL-encode those characters (`@` → `%40`).

Put it in `.env.local` as `MONGODB_URI`, and set `MONGODB_DB_NAME=profitex`.

> Atlas connection strings often end in `/?retryWrites=...` with **no database
> name** in the path. That is why `MONGODB_DB_NAME` matters: without it Mongoose
> silently writes everything to a database called `test`.

**✅ Check:** `npm run doctor` reports **✅ MongoDB**.

---

## 4. Paystack

1. [dashboard.paystack.com](https://dashboard.paystack.com) → **Settings** →
   **API Keys & Webhooks**.
2. Copy the **Test Secret Key** (`sk_test_…`) into `PAYSTACK_SECRET_KEY`.
   Use test keys until step 9.
3. Leave the webhook field alone for now — you set it in [step 7](#7-point-the-gateways-at-your-deployment),
   once you have a public URL.

---

## 5. Flutterwave

1. [dashboard.flutterwave.com](https://dashboard.flutterwave.com) → **Settings** →
   **API Keys**.
2. Copy the **Secret Key** (`FLWSECK_TEST-…`) into `FLUTTERWAVE_SECRET_KEY`.
3. **Settings** → **Webhooks**. In **Secret hash**, type any long random string —
   generate one with `openssl rand -hex 32`. Save it.
4. Put that **same** string into `FLUTTERWAVE_SECRET_HASH` in your `.env.local`.

> Flutterwave does not sign its webhook bodies. The secret hash is the only thing
> proving a webhook really came from Flutterwave, so this must match exactly or
> every Flutterwave webhook will be rejected (by design).

---

## 6. Deploy

The bot needs a public HTTPS URL for three things: the Telegram webhook, the two
payment webhooks, and the browser redirect after checkout.

### Do I need to buy a domain?

**No.** Vercel gives you `https://<project-name>.vercel.app` free, with a real
TLS certificate. That is a fully valid HTTPS endpoint, and it is all that
Telegram, Paystack and Flutterwave require. Nothing in this project serves a
website to the public.

The only place a member ever sees the URL is the one-second redirect page after
checkout, before the bot bounces them back into Telegram. A custom domain buys
you a slightly more polished address on that page and nothing else. If you want
one later, add it in Vercel → Settings → Domains and change `PUBLIC_URL` — no
code changes, though you must re-run `npm run set-webhook` and update both
gateway webhook URLs.

> One thing a domain *does* sometimes matter for: Paystack and Flutterwave
> occasionally ask for a business website during **account** approval. That is
> a paperwork question about your account, not a technical requirement of this
> bot, and Profitex will already have cleared it if their accounts are live.

---

### Option A — Vercel (Hobby plan)

Everything is already wired for it: `api/index.ts` is the serverless entry point
and `vercel.json` rewrites every path to it.

```bash
npm i -g vercel
vercel login
vercel link          # create the project
vercel --prod        # first deploy, to learn the URL
```

Then add the environment variables — **Project → Settings → Environment
Variables**, or `vercel env add <NAME> production` per variable. On Vercel these
values must be:

```
NODE_ENV=production
BOT_MODE=webhook
ENABLE_INTERNAL_CRON=false          # Vercel Cron drives the scheduler instead
PUBLIC_URL=https://<your-project>.vercel.app
CRON_SECRET=<openssl rand -hex 32>  # Vercel Cron sends this as a Bearer token
SCHEDULER_BUDGET_MS=50000           # fits inside vercel.json's maxDuration of 60
```

Redeploy after adding them: `vercel --prod`.

#### How the Hobby cron limit is handled

| | Hobby | Pro |
| --- | --- | --- |
| Minimum cron interval | **once per day** | once per minute |
| When it actually fires | any minute within the scheduled hour, **UTC only** | same |
| Cron jobs per project | 2 | 100 |
| Function `maxDuration` | up to 300s (60s set here) | up to 800s |

`vercel.json` ships with `0 6 * * *` — 06:00 UTC, 07:00 Lagos — which is the most
frequent schedule Hobby accepts. Three things in the code make that sufficient:

**1. Reminder windows are ranges, not exact moments.** The scheduler asks "is
this subscription inside the 7-day, 3-day or 24-hour window *right now*", not
"is it exactly 7 days out". A pass that only wakes once every 24 hours still
lands inside every window. This is tested directly — `tests/integration.ts`
replays a full 30-day subscription against a once-a-day scheduler at three
different times of day and asserts all three reminders and the removal fire
exactly once each.

**2. Every pass is time-budgeted and resumable.** A pass works for
`SCHEDULER_BUDGET_MS` and then stops cleanly, reporting how much is left. If
anything remains, it starts a **follow-up pass in a fresh invocation** before
responding. One daily trigger therefore fans out into as many invocations as the
backlog needs — a hundred expiring members are not capped by one 60-second
window. `MAX_SCHEDULER_CHAIN` (default 12) stops that from ever looping.

**3. Nobody who paid waits a day.** Access is granted by the gateway webhook the
moment the payment clears, which has nothing to do with cron. And if a webhook is
ever missed, `/status` and `/link` re-check that subscriber's own recent payments
on the spot and grant access immediately.

What the daily cadence genuinely costs you: **an expired member may stay in the
group for up to 24 hours** after their end date, until the morning pass. They get
all three reminders beforehand, so it is not a surprise to them — but if you want
removals within 30 minutes, do the next bit.

#### Removals within 30 minutes, still free

Use any external scheduler to call the maintenance endpoint. The daily Vercel
cron stays in place as a backstop.

At [cron-job.org](https://cron-job.org) (free, unlimited):

| Field | Value |
| --- | --- |
| URL | `https://<your-project>.vercel.app/api/cron/run?async=1` |
| Schedule | Every 15 minutes |
| Request method | `POST` |
| Header | `x-cron-secret` = your `CRON_SECRET` |

**Use `?async=1`.** Most pingers cut a request off after ~30 seconds and report
that as a failure. With `async=1` the endpoint hands the work to a separate
invocation and answers in about two seconds, so the pinger always sees a clean
`202`.

> GitHub Actions can do the same job, but on a **private** repo its minutes come
> out of the free 2,000/month and every run is rounded up to a whole minute —
> about 1,440/month at 30-minute intervals, or 2,880 at 15. An external pinger
> avoids that accounting entirely, which is why this project no longer ships a
> workflow file.

---

### Option B — Always-on host (Railway, Render, Fly.io, or a VPS)

If you would rather not think about cron limits at all, the bot also runs as one
long-lived process with its own 15-minute scheduler built in.

**Railway**

1. Push this project to GitHub.
2. [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo**.
3. **Settings** → **Build Command**: `npm run build`. **Start Command**: `npm start`.
4. **Variables** → paste everything from your `.env.local`, with these values:

   ```
   NODE_ENV=production
   BOT_MODE=webhook
   ENABLE_INTERNAL_CRON=true
   CRON_SCHEDULE=*/15 * * * *
   APP_TIMEZONE=Africa/Lagos
   ```

5. **Settings** → **Networking** → **Generate Domain**, then set `PUBLIC_URL` to
   it and redeploy.

**Render** is the same shape: Web Service → Build `npm install && npm run build`
→ Start `npm start` → environment variables → copy the `.onrender.com` URL.

> On Render's free tier the instance sleeps when idle, which delays reminders and
> can drop webhooks. Use a paid instance, or stay on Vercel.

## 7. Point the gateways at your deployment

With `PUBLIC_URL` known, set these three webhook URLs.

**Telegram** — run locally, with `.env.local` holding the production `PUBLIC_URL`,
`BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET`:

```bash
npm run set-webhook
```

It registers `https://<your-domain>/api/telegram` **with `chat_member` in
`allowed_updates`**. That opt-in is what lets the bot see who joins and match
them to a payment — a webhook set by hand without it will silently break join
detection.

**Paystack** — Dashboard → Settings → API Keys & Webhooks → **Webhook URL**:

```
https://<your-domain>/api/webhooks/paystack
```

**Flutterwave** — Dashboard → Settings → Webhooks → **URL**:

```
https://<your-domain>/api/webhooks/flutterwave
```

Tick all the event boxes and enable **webhook retries**. Confirm the secret hash
still matches `FLUTTERWAVE_SECRET_HASH`.

**✅ Check:** open `https://<your-domain>/health` in a browser — you should see
`{"ok":true,"service":"profitex-telegram-bot",…}`.

---

## 8. Create the plans

With `.env.local` pointing at the production database:

```bash
npm run seed
```

That creates Monthly / Quarterly / Yearly at placeholder prices. **Change them
to the academy's real prices from inside Telegram** — `/admin` → **Plans** →
pick one → **Change price**. No redeploy needed.

Now run the full pre-flight:

```bash
npm run doctor
```

Work through anything marked ❌ until you see only ✅ (a warning about test-mode
gateway keys is expected at this stage).

---

## 9. Test it end to end — with test keys

Do this before touching live keys.

1. **Start** — message your bot, send `/start`. The welcome and menu appear.
2. **Plans** — tap **View Plans**, pick one, tap **Pay with Paystack**.
3. **Email** — it asks once and remembers it.
4. **Pay** — tap **Pay Now**. Use Paystack's test card:
   `4084 0840 8408 4081`, any future expiry, CVV `408`, OTP `123456`.
5. **Confirm** — you are redirected back into Telegram and the bot sends
   **Payment confirmed** with a **Join the group** button.
6. **Join** — tap it. You are in the group, and you get the welcome DM.
7. **Link is single-use** — open the same link again. Telegram refuses it.
8. **Status** — `/status` shows the plan and the expiry date.
9. **Repeat with Flutterwave** — test card `5531 8866 5214 2950`, expiry `09/32`,
   CVV `564`, PIN `3310`, OTP `12345`.
10. **Renewal extends** — pay again while still active. `/status` should show
    roughly *double* the remaining time, not a reset.
11. **Reminders and removal** — this is what `simulate-expiry` is for:

    ```bash
    npm run simulate-expiry <your-telegram-id> 6      # due the 7-day notice
    npm run cron                                      # → you receive it
    npm run simulate-expiry <your-telegram-id> 2      # due the 3-day notice
    npm run cron
    npm run simulate-expiry <your-telegram-id> 0.5    # due the 24-hour notice
    npm run cron
    npm run simulate-expiry <your-telegram-id> -1     # expired
    npm run cron                                      # → removed + told why
    ```

    You can also run the pass from Telegram with `/cron`.
12. **Admin** — `/admin`, then walk through **Stats**, **Members**, **Payments**,
    **Find member**, **Post to group** and a **Broadcast** to *Active only*.

**✅ Check:** every step above behaved. Verify in the database (or via
`/payments`) that each test payment has exactly one subscription behind it.

---

## 10. Switch to live

1. **Paystack** → Settings → API Keys & Webhooks → toggle to **Live**. Copy the
   live secret key (`sk_live_…`) into `PAYSTACK_SECRET_KEY`. Re-enter the live
   **webhook URL** — test and live webhooks are configured separately.
2. **Flutterwave** → switch the dashboard to **Live**. Copy the live secret key
   into `FLUTTERWAVE_SECRET_KEY`, and set the live **webhook URL** and the
   **same secret hash** again.
3. Update both variables on your host and redeploy.
4. `npm run doctor` — it should now report **LIVE mode** for both gateways.
5. Set the real prices: `/admin` → **Plans**.
6. Do **one real payment** of the smallest plan with your own card, end to end.
   Refund it afterwards from the gateway dashboard.
7. Announce the bot to the group: `/post` a message with a link to
   `https://t.me/<your_bot_username>`.

### Moving existing members over

Existing members are not in the database, so the expiry job does not know about
them — it only ever touches subscriptions it has records for, so nobody gets
removed by surprise.

Give each existing member the access they already paid for:

```
/grant <their telegram id> 30
```

or `/grant <id> monthly`. From then on they are handled like everyone else.
Once everyone is on record, you can switch on `ENFORCE_PAID_MEMBERS_ONLY=true`
so anyone who turns up without a subscription is removed automatically.

---

## Environment variables

> **Every `.env*` file is git-ignored**, including `.env.example`. Nothing
> carrying a secret can be committed by accident. The trade-off is that a fresh
> clone has no template — this table *is* the template, so keep it current.
> `.env.local` is loaded first and overrides `.env`.


| Variable | Required | What it is |
| --- | --- | --- |
| `BOT_TOKEN` | ✅ | From BotFather |
| `BOT_MODE` | ✅ | `polling` locally, `webhook` in production |
| `PUBLIC_URL` | webhook mode | `https://your-domain` — no trailing slash |
| `TELEGRAM_WEBHOOK_SECRET` | strongly advised | `openssl rand -hex 32` |
| `MONGODB_URI` | ✅ | Atlas connection string |
| `MONGODB_DB_NAME` | | Defaults to the database in the URI |
| `GROUP_CHAT_ID` | ✅ | Negative supergroup id |
| `GROUP_NAME` / `BRAND_NAME` | | Used in message copy |
| `SUPPORT_USERNAME` | | Username (no `@`) shown in /help |
| `ADMIN_TELEGRAM_IDS` | ✅ | Comma-separated numeric ids |
| `PAYSTACK_SECRET_KEY` | one gateway | `sk_test_…` / `sk_live_…` |
| `FLUTTERWAVE_SECRET_KEY` | one gateway | `FLWSECK…` |
| `FLUTTERWAVE_SECRET_HASH` | if using Flutterwave | Must match the dashboard exactly |
| `CURRENCY` | | Defaults to `NGN` |
| `CRON_SECRET` | ✅ in production | Protects `/api/cron/run` |
| `ENABLE_INTERNAL_CRON` | | `true` on always-on hosts, `false` on Vercel |
| `CRON_SCHEDULE` | | Default `*/15 * * * *`. Only used when `ENABLE_INTERNAL_CRON=true` |
| `SCHEDULER_BUDGET_MS` | | Default `50000`. Must fit inside the host's per-invocation limit |
| `MAX_SCHEDULER_CHAIN` | | Default `12`. Cap on follow-up passes from one trigger |
| `APP_TIMEZONE` | | Default `Africa/Lagos` — affects displayed dates |
| `INVITE_LINK_TTL_MINUTES` | | Default `60` |
| `BROADCAST_RATE_PER_SEC` | | Default `20`. Do not exceed 30 |
| `ENFORCE_PAID_MEMBERS_ONLY` | | `true` kicks anyone who joins without a subscription |

---

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Bot does not reply at all | `npm run doctor`. In webhook mode check `getWebhookInfo` reports no `last_error_message`; in polling mode make sure no webhook is registered (`npm run delete-webhook`). |
| "Bot is not an administrator" | Re-add it as admin with **Invite Users via Link** and **Ban Users** enabled. Removing and re-adding the bot resets its rights. |
| Invite links are not created | Same as above — the invite-link permission specifically. |
| Members are not removed on expiry | The group must be a **supergroup**. `npm run doctor` says which type yours is. |
| Joins are not matched to payments | `chat_member` is missing from `allowed_updates`. Re-run `npm run set-webhook`. |
| Paystack webhook rejected (401) | `PAYSTACK_SECRET_KEY` must be the *same* key (test vs live) as the dashboard that sent it. The signature is HMAC-SHA512 over the raw body. |
| Flutterwave webhook rejected (401) | `FLUTTERWAVE_SECRET_HASH` does not match the dashboard's secret hash. |
| Paid but no access | `/payments` in the bot shows the record. The maintenance pass reconciles any verified-but-unfulfilled payment automatically — run `/cron` to force it. |
| Removals lag by up to a day on Vercel Hobby | Expected: Hobby cron fires once daily. Point an external pinger at `/api/cron/run?async=1` — see [Option A](#option-a--vercel-hobby-plan). |
| GitHub Action fails: "recent account payments have failed or your spending limit needs to be increased" | GitHub billing, not the bot. Actions is blocked account-wide. Fix it under GitHub → Settings → Billing, or delete `.github/workflows/scheduler.yml` and use an external pinger. The bot keeps working on the daily Vercel cron either way. |
| Cron endpoint returns but nothing happened | Check the JSON it returns: `report.hasMoreWork` and `chain` show whether a follow-up pass was started. `chain: "unconfigured"` means `PUBLIC_URL` or `CRON_SECRET` is missing on the host. |
| Broadcast stalls half way | Its queue is persistent — it resumes on the next pass. Run `/cron`, or check the delivery summary. |
| `MongooseServerSelectionError` | Atlas **Network Access** is not set to `0.0.0.0/0`, or the password is not URL-encoded. |

---

## Handover checklist

- [ ] Bot created, description and picture set, privacy mode enabled
- [ ] Group is a supergroup; bot is admin with invite + ban rights
- [ ] Group's shared invite link revoked
- [ ] Atlas cluster live, user created, network access open
- [ ] Both gateways in live mode with live webhook URLs configured
- [ ] `PUBLIC_URL`, `TELEGRAM_WEBHOOK_SECRET` and `CRON_SECRET` set on the host
- [ ] External pinger hitting `/api/cron/run?async=1` every 15 minutes, or an accepted 24-hour removal lag
- [ ] `npm run set-webhook` run against the production URL
- [ ] `npm run doctor` all green
- [ ] Real prices set via `/admin` → Plans
- [ ] One real payment made, verified, and refunded
- [ ] Existing members granted access with `/grant`
- [ ] Every team admin's id in `ADMIN_TELEGRAM_IDS`
- [ ] [ADMIN_GUIDE.md](ADMIN_GUIDE.md) handed to the Profitex team
