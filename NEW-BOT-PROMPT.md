# Starter brief for a Telegram subscription bot

Paste the block below to Claude Code as the **first** message on a new project.
It front-loads every trap that cost real debugging time on this build, so they
get handled up front instead of in production.

Replace the bracketed parts. Delete anything you don't need.

---

Build a Telegram subscription bot that sells access to a private Telegram
[channel / supergroup].

**Stack:** Node.js + TypeScript (strict), grammY, MongoDB Atlas via Mongoose,
Express for webhooks, deployed to Vercel on the **Hobby** plan.

**Payments:** [Paystack / Flutterwave], Nigerian Naira.

**Plans:** [1 month 20k, 3 months 55k, ...]. Prices must be editable from inside
Telegram, not hardcoded.

**What it must do**
- Subscriber picks a plan, pays, and gets a single-use invite link automatically.
- Reminders 7 days, 3 days and 24 hours before expiry, then automatic removal.
- Renewing early *extends* the end date; it never restarts it.
- Admin commands inside Telegram: member list, payment history, plan management,
  manual grant/revoke, broadcast to members, post to the channel, direct message.

**Handle these from the start — each one is a real failure mode**

1. *Money.* Store amounts as integers in kobo, never floats. Create the payment
   record **before** sending anyone to checkout, so abandoned checkouts are
   visible. Verify every payment by calling the gateway server-side; never trust
   a redirect, a webhook body or a screenshot. Check amount **and** currency.
2. *Exactly once.* Webhooks retry, and the redirect, the "I have paid" button and
   a reconciliation job can all fire together. Guard fulfilment with a database
   level claim so one payment can only ever produce one subscription. Add a job
   that repairs payments verified but not fulfilled.
3. *Paystack statuses.* `abandoned` means "not finished", not "failed" — the
   checkout link still works. Telling people who have not paid that their
   payment failed is confusing. Signature is HMAC-SHA512 over the **raw** body;
   verify before parsing JSON.
4. *Telegram removal needs a supergroup or channel.* Members cannot be removed
   from a basic group. Remove with `banChatMember` then a plain
   `unbanChatMember` — do **not** pass `only_if_banned`, or a ban that has not
   registered yet leaves the member permanently banned.
5. *Invite links.* `member_limit: 1` plus an expiry, one per payment, revoking
   the previous one. Turn off the chat's own shared link.
6. *`chat_member` is opt-in.* It must be listed in `allowed_updates` when setting
   the webhook, or joins are never seen. Set a webhook secret token and check it.
7. *One answer per button tap.* `answerCallbackQuery` works once. Anything the
   user must read goes in an edited message, not a second toast — otherwise the
   screen appears frozen.
8. *Blank environment variables.* Treat a variable that is present but empty as
   unset. An empty string fails a `.url()` rule and takes the whole config down;
   half-filled files are normal during setup.
9. *Vercel Hobby cron runs once a day.* Make each scheduled pass time-budgeted
   and resumable, and have it trigger a follow-up pass when work remains. Derive
   reminders from the stored end date as *ranges* ("within 7 days"), not exact
   moments, so a daily run still hits every window. Never let access depend on
   cron: grant on the webhook, and re-check on demand when the user asks.
10. *An admin bot receives every message in a group.* Discard group traffic
    before it touches the database, or a busy group burns invocations and writes.
11. *Serverless state.* Persist grammY sessions in MongoDB, cache the Mongoose
    connection, and key any stored credentials by bot id so changing the bot
    token cannot reuse the old bot's session.
12. *Show real names, not settings.* Label chats with the title Telegram
    reports. Printing a configured "brand name" makes it look like messages are
    going somewhere else.

**How I want you to work**
- Write tests as you go, against an in-memory MongoDB, with Telegram stubbed via
  a grammY API transformer and the payment gateway stubbed at the fetch layer.
  Cover: duplicate and concurrent webhooks, underpayment, wrong currency,
  abandoned then completed, each reminder firing exactly once, renewal
  extension, removal, and a daily-cron simulation over a full subscription.
- When a test fails, work out whether the test or the code is wrong before
  changing either. Scope assertions to the subscriber under test — jobs that
  sweep every record will legitimately affect other fixtures.
- Verify claims about Telegram, Paystack and Vercel against their current docs
  rather than memory. State clearly what you have and have not actually tested.
- Add a `doctor` command and a browser-openable setup endpoint that report what
  is still misconfigured, so going live does not need a terminal.
- Keep secrets out of git: ignore every `.env*` form, and keep the variable
  reference in the deployment guide instead.

Ask me for anything you need (ids, keys, plan prices) rather than guessing.
