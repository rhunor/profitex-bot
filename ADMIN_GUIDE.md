# Profitex Bot — Admin Guide

Everything you need to run the academy from inside Telegram. No website, no
dashboard, no developer.

Open a private chat with the bot and send **`/admin`** to see the menu.

---

## How a new member joins — what happens on its own

1. They open the bot and tap **View Plans**.
2. They pick a plan and pay with Paystack or Flutterwave.
3. The bot checks with the payment company that the money really arrived.
4. It sends them a **private invite link** that works **once** and expires in an hour.
5. They tap it and they are in the group.

You do nothing. If they never pay, they never get a link.

## How a member leaves — also on its own

- **7 days before** their subscription ends, they get a reminder with a renew button.
- **3 days before**, a firmer one.
- **24 hours before**, a final notice.
- **When it expires**, the bot removes them from the group and tells them why,
  with a one-tap way back in.

Each reminder is sent once. If they renew, the remaining reminders stop.

---

## The admin menu

Send `/admin`.

| Button | What it shows |
| --- | --- |
| **📊 Stats** | Active members, how many expire this week, total collected, payment counts |
| **👥 Members** | Every active subscriber with their plan and expiry date |
| **💳 Payments** | Every payment attempt with its reference, amount and outcome |
| **🧾 Plans** | Add, rename, reprice or retire plans |
| **📣 Broadcast** | Message many members privately |
| **📢 Post to group** | Send a message into the academy group |
| **🔍 Find member** | Look someone up and act on them |

---

## Everyday tasks

### Send signals or analysis to the group

**`/post`** then send your message — text, a chart, a screenshot, a PDF.
It appears in the group as if you posted it.

You can also **reply** to any message with `/post` to push that exact message
into the group.

### Message everyone

**📣 Broadcast**. Choose who:

- **All subscribers** — everyone who has ever used the bot
- **Active only** — people currently paying
- **Expired only** — lapsed members, for a win-back offer

Then send the message you want delivered. The bot shows you the recipient count
and a preview. Tap **🚀 Send now**.

Messages go out at a safe speed so Telegram does not block the bot — a large
send takes a few minutes. When it finishes you get a summary: how many were
delivered and how many failed. *Failed* almost always means that person blocked
the bot or never started a chat with it.

> A broadcast goes to each person's **private chat**. To post in the group
> itself, use **📢 Post to group**.

### Message one person

**🔍 Find member** → search by name, @username or id → open their card → **✉️ Message**.

Or, if you know their id: **`/dm 5123456789 Your renewal is due tomorrow.`**

You do not need their username, and they never see your personal account.

### Look someone up

**`/find Tunde`** or **`/find @tunde_fx`** or **`/find 5123456789`**.

Their card shows their plan, expiry, time left, whether they are in the group,
how much they have paid, and their recent payments.

### Give someone access without a payment

For a giveaway, a partner, a competition winner, or someone who paid by transfer:

**`/grant 5123456789 monthly`** — gives them the monthly plan
**`/grant 5123456789 14`** — gives them 14 days

They get an invite link immediately, exactly like a paying member. If they
already have access, the time is **added on top**.

### Take access away immediately

**`/revoke 5123456789`**

They are removed from the group, their links stop working, and they are told
their access was revoked.

### Change prices

**🧾 Plans** → tap a plan → **💰 Change price** → send the new amount
(e.g. `30000`).

The new price applies to the next person who pays. Nobody's current subscription
changes.

You can also rename a plan, change its length, add a new one, or **retire** one.
Retiring hides it from new subscribers and leaves existing subscriptions alone.

---

## Command reference

**Everyone**

| Command | What it does |
| --- | --- |
| `/start` | Main menu |
| `/plans` | See the plans |
| `/status` | Their subscription and expiry date |
| `/link` | A fresh invite link (paid members only) |
| `/renew` | Renew |
| `/help` | Help and support |

**Admins only**

| Command | What it does |
| --- | --- |
| `/admin` | The admin menu |
| `/stats` | Overview |
| `/members` | Active subscribers |
| `/payments` | Payment history |
| `/find <name or id>` | Look someone up |
| `/grant <id> <plan or days>` | Give or extend access |
| `/revoke <id>` | End access now |
| `/dm <id> <message>` | Message one member |
| `/post <message>` | Post in the group |
| `/broadcast` | Message many members |
| `/cron` | Run the reminder and expiry check right now |

---

## Questions members will ask you

**"My link says it's invalid."**
Links work once and expire after an hour. Tell them to send **`/link`** to the
bot for a new one. It costs nothing and they do not pay again.

**"I paid but nothing happened."**
Ask them to tap **✅ I have paid** on their checkout message, or send `/status`.
If the money left their account and they still have no access, find their
payment with **💳 Payments** and send us the reference.

**"Can I renew early?"**
Yes, and they should. Days they have left are added to the new period — they
lose nothing.

**"I was removed but I paid!"**
Check **🔍 Find member**. If their subscription really is active, use
**`/grant`** to top them up and send them `/link`.

**"Can I share my link with a friend?"**
No. Each link admits one person and then stops working. If a friend uses it
first, the buyer cannot get in — and they will come to you about it.

---

## Things worth knowing

- **Never re-enable the group's shared invite link.** The bot's single-use links
  are the only thing keeping non-payers out. If the shared link comes back,
  anyone with it walks in for free.
- **Do not remove the bot's admin rights.** Without **Invite Users via Link** it
  cannot create links; without **Ban Users** it cannot remove expired members.
  If you ever re-add the bot, set both again.
- **Removed members are not banned.** They can come back the moment they pay.
- **Nobody is removed without warning.** Three reminders go out first, and the
  removal message explains why and how to return.
- **The bot only touches people it has records for.** Members added by hand
  before the bot existed are never removed — use `/grant` to put them on record.

---

## If something looks wrong

1. Send **`/cron`**. That runs the reminder and expiry check immediately and
   reports what it did. It also repairs any payment that was confirmed but did
   not grant access.
2. Send **`/stats`** — if the numbers look right, the database is healthy.
3. Try **`/post`** with a test message — if that works, the bot still has its
   group permissions.

If any of those fail, contact **Rhunor Run Dev** with:

- what you were doing
- the payment reference or member id involved
- the time it happened

---

*Built for Profitex — Profitable Forex Trading Academy by Rhunor Run Dev.*
