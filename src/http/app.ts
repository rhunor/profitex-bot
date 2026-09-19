import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { webhookCallback } from 'grammy';
import { getEnv } from '../config/env';
import { createLogger } from '../utils/logger';
import { connectToDatabase } from '../db/connect';
import { escapeHtml } from '../utils/text';
import { ALLOWED_UPDATES, getBot, publishCommands } from '../bot';
import { getGateway } from '../services/payments';
import { finalizePayment } from '../services/payment.service';
import { runScheduledWork } from '../jobs/scheduler';
import { processBroadcastQueue } from '../services/broadcast.service';
import { chainFollowUpPass } from '../services/dispatch';
import { Plan, type Gateway } from '../models';
import { seedIfCatalogueEmpty } from '../services/plan-seed';
import { checkCommunityRights } from '../services/telegram';
import { diagnoseLookup, lookupMembership, verifyTrialSourceAccess } from '../services/mtproto';
import { publicUrl } from '../config/env';

const log = createLogger('http');

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      rawBody?: Buffer;
    }
  }
}

/** Wraps an async route so a rejected promise becomes a 500 instead of a hang. */
function asyncRoute(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    handler(req, res).catch(next);
  };
}

function firstQueryValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

export function createApp(): Express {
  const env = getEnv();
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', true);

  // The raw body is kept because Paystack signs the exact bytes it sent.
  app.use(
    express.json({
      limit: '1mb',
      verify: (req, _res, buf) => {
        (req as Request).rawBody = Buffer.from(buf);
      },
    }),
  );
  app.use(express.urlencoded({ extended: false }));

  /* ── Health ──────────────────────────────────────────────── */

  app.get(['/', '/health'], (_req, res) => {
    res.status(200).json({
      ok: true,
      service: 'profitex-telegram-bot',
      mode: env.BOT_MODE,
      time: new Date().toISOString(),
    });
  });

  /* ── Telegram webhook ────────────────────────────────────── */

  app.post(
    '/api/telegram',
    asyncRoute(async (req, res) => {
      // Verified before any work is done: an unauthenticated caller must never
      // be able to make the bot act.
      if (env.TELEGRAM_WEBHOOK_SECRET) {
        const provided = req.get('x-telegram-bot-api-secret-token');
        if (provided !== env.TELEGRAM_WEBHOOK_SECRET) {
          log.warn('Rejected a Telegram webhook with a bad secret token');
          res.status(401).json({ ok: false });
          return;
        }
      }

      await connectToDatabase();
      const bot = await getBot();

      const handle = webhookCallback(bot, 'express', {
        onTimeout: 'return',
        timeoutMilliseconds: 30_000,
      });

      await handle(req, res);
    }),
  );

  /* ── Payment webhooks ────────────────────────────────────── */

  async function handleGatewayWebhook(gatewayId: Gateway, req: Request, res: Response): Promise<void> {
    const gateway = getGateway(gatewayId);
    const rawBody = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));

    if (!gateway.verifyWebhookSignature(rawBody, req.headers)) {
      log.warn(`Rejected an unsigned ${gatewayId} webhook`);
      res.status(401).json({ ok: false, reason: 'invalid signature' });
      return;
    }

    const parsed = gateway.parseWebhook(req.body);

    // Acknowledge immediately. A non-200 makes the gateway retry, and there is
    // nothing to retry for events we deliberately ignore.
    res.status(200).json({ ok: true });

    if (!parsed.actionable || !parsed.reference) {
      log.debug(`Ignoring ${gatewayId} event`, { event: parsed.event });
      return;
    }

    try {
      await connectToDatabase();
      const result = await finalizePayment(parsed.reference, {
        gatewayReference: parsed.gatewayReference,
        trigger: `${gatewayId}-webhook`,
      });
      log.info(`Processed ${gatewayId} webhook`, { reference: parsed.reference, outcome: result.outcome });
    } catch (error) {
      log.error(`Failed to process ${gatewayId} webhook`, { reference: parsed.reference, error });
    }
  }

  app.post(
    '/api/webhooks/paystack',
    asyncRoute(async (req, res) => handleGatewayWebhook('paystack', req, res)),
  );

  // FLUTTERWAVE-DISABLED: route removed so the endpoint 404s while unused.
  // app.post(
  //   '/api/webhooks/flutterwave',
  //   asyncRoute(async (req, res) => handleGatewayWebhook('flutterwave', req, res)),
  // );

  /* ── Browser redirect after checkout ─────────────────────── */

  app.get(
    '/api/payment/callback',
    asyncRoute(async (req, res) => {
      const reference =
        firstQueryValue(req.query.reference) ??
        firstQueryValue(req.query.tx_ref) ??
        firstQueryValue(req.query.trxref);

      const transactionId = firstQueryValue(req.query.transaction_id);

      if (!reference) {
        res.status(400).send(resultPage('Missing payment reference', 'We could not identify this payment.', null));
        return;
      }

      let heading = 'Payment received';
      let body = 'Head back to Telegram — your invite link is waiting for you.';

      try {
        await connectToDatabase();
        const result = await finalizePayment(reference, {
          gatewayReference: transactionId,
          trigger: 'redirect',
        });

        if (result.outcome === 'pending' || result.outcome === 'in_progress') {
          heading = 'Still confirming';
          body = 'Your payment has not been confirmed yet. Open Telegram and tap "I have paid" in a few seconds.';
        } else if (result.outcome === 'failed' || result.outcome === 'amount_mismatch') {
          heading = 'Payment not completed';
          body = 'This payment did not go through, so no access was granted. You can try again from the bot.';
        } else if (result.outcome === 'unknown_reference') {
          heading = 'Unknown payment';
          body = 'We could not match this payment to an order. Please contact support.';
        }
      } catch (error) {
        log.error('Redirect verification failed', { reference, error });
        heading = 'Checking your payment';
        body = 'Open Telegram and tap "I have paid" to finish up.';
      }

      let deepLink: string | null = null;
      try {
        const bot = await getBot();
        if (bot.botInfo?.username) {
          deepLink = `https://t.me/${bot.botInfo.username}?start=ref_${encodeURIComponent(reference)}`;
        }
      } catch {
        /* fall back to a plain page without the button */
      }

      if (deepLink) {
        res.status(200).send(resultPage(heading, body, deepLink));
        return;
      }
      res.status(200).send(resultPage(heading, body, null));
    }),
  );

  /* ── Scheduler ───────────────────────────────────────────── */

  function cronAuthorised(req: Request): boolean {
    const secret = env.CRON_SECRET;
    if (!secret) return env.NODE_ENV !== 'production';

    const header = req.get('x-cron-secret');
    const bearer = req.get('authorization');
    const query = firstQueryValue(req.query.secret);

    // Vercel Cron sends `Authorization: Bearer $CRON_SECRET` automatically.
    return header === secret || bearer === `Bearer ${secret}` || query === secret;
  }

  const cronHandler = asyncRoute(async (req, res) => {
    if (!cronAuthorised(req)) {
      res.status(401).json({ ok: false, reason: 'unauthorised' });
      return;
    }

    const mode = firstQueryValue(req.query.mode) === 'broadcast' ? 'broadcast' : 'full';
    const depth = Number(firstQueryValue(req.query.depth) ?? 0) || 0;
    const async = ['1', 'true', 'yes'].includes((firstQueryValue(req.query.async) ?? '').toLowerCase());

    // `async=1` hands the work to a fresh invocation and answers straight away.
    // External pingers (cron-job.org and friends) cut requests off after ~30s
    // and report a timeout as a failure; a busy pass can take longer than that.
    if (async) {
      const chain = await chainFollowUpPass(depth, mode);
      res.status(202).json({ ok: true, mode, depth, started: chain === 'chained', chain });
      return;
    }

    // Only the synchronous path touches the database.
    await connectToDatabase();

    if (mode === 'broadcast') {
      const report = await processBroadcastQueue();
      // Anything still queued gets its own invocation rather than waiting for
      // the next scheduled run.
      const chain = report.remaining > 0 ? await chainFollowUpPass(depth, 'broadcast') : undefined;
      res.status(200).json({ ok: true, mode, depth, report, chain });
      return;
    }

    const report = await runScheduledWork();
    const chain = report.hasMoreWork ? await chainFollowUpPass(depth, 'full') : undefined;

    res.status(200).json({ ok: true, mode, depth, report, chain });
  });

  app.get('/api/cron/run', cronHandler);

  /* ── One-time setup, from a browser ──────────────────────── */

  /**
   * Registers the Telegram webhook and publishes the command menus, then reports
   * what is still missing. Replaces running `npm run set-webhook` locally.
   *
   * Open once after the first deploy, and again after any change to the admin
   * list or the URL:  /api/setup?secret=<CRON_SECRET>
   * Safe to repeat — every call simply re-applies the same configuration.
   */
  app.get(
    '/api/setup',
    asyncRoute(async (req, res) => {
      if (!env.CRON_SECRET || !cronAuthorised(req)) {
        res.status(401).json({
          ok: false,
          reason: env.CRON_SECRET
            ? 'Wrong or missing secret. Open /api/setup?secret=<CRON_SECRET>.'
            : 'CRON_SECRET is not set in the environment variables, so setup is locked.',
        });
        return;
      }

      await connectToDatabase();
      const bot = await getBot();

      const webhookUrl = publicUrl('/api/telegram');
      await bot.api.setWebhook(webhookUrl, {
        allowed_updates: [...ALLOWED_UPDATES],
        secret_token: env.TELEGRAM_WEBHOOK_SECRET,
        drop_pending_updates: false,
      });
      await publishCommands(bot);

      // First run on an empty database gets the starter plans; never touches existing ones.
      const seededPlans = await seedIfCatalogueEmpty();

      const rights = env.groupConfigured ? await checkCommunityRights() : null;

      // Free month: prove the full-API sign-in works and the source is visible.
      // `?checkUser=<telegram id>` additionally looks one person up, read-only.
      const trialVars = {
        TRIAL_SOURCE_CHAT_ID: env.TRIAL_SOURCE_CHAT_ID,
        TRIAL_ELIGIBLE_FROM: env.TRIAL_ELIGIBLE_FROM,
        TELEGRAM_API_ID: env.TELEGRAM_API_ID,
        TELEGRAM_API_HASH: env.TELEGRAM_API_HASH,
      };
      const missingTrialVars = Object.entries(trialVars).filter(([, v]) => !v).map(([k]) => k);
      let freeMonth: Record<string, unknown> = { enabled: false };
      if (env.trialEnabled && env.TRIAL_SOURCE_CHAT_ID) {
        const access = await verifyTrialSourceAccess(env.TRIAL_SOURCE_CHAT_ID);
        freeMonth = {
          enabled: true,
          source: access.ok ? access.title : null,
          sourceReachable: access.ok,
          eligibleIfJoinedOnOrAfter: env.trialEligibleFrom?.toISOString(),
          days: env.TRIAL_DAYS,
          ...(access.ok ? {} : { error: access.reason }),
        };
        const checkUser = Number(firstQueryValue(req.query.checkUser));
        if (Number.isInteger(checkUser) && checkUser > 0) {
          // Step-by-step, so a failure names the exact step and Telegram's error.
          freeMonth.diagnosis = await diagnoseLookup(env.TRIAL_SOURCE_CHAT_ID, checkUser);
        }
        if (access.ok && Number.isInteger(checkUser) && checkUser > 0) {
          const membership = await lookupMembership(env.TRIAL_SOURCE_CHAT_ID, checkUser);
          const joinedAt = membership.status === 'member' ? membership.joinedAt : null;
          freeMonth.checkUser = {
            telegramId: checkUser,
            ...membership,
            wouldQualify: Boolean(joinedAt && env.trialEligibleFrom && joinedAt >= env.trialEligibleFrom),
          };
        }
      } else if (missingTrialVars.length < 4) {
        freeMonth = { enabled: false, missing: missingTrialVars };
      }

      const info = await bot.api.getWebhookInfo();
      const activePlans = await Plan.countDocuments({ isActive: true });

      const todo: string[] = [];
      if (!env.TELEGRAM_WEBHOOK_SECRET) todo.push('Set TELEGRAM_WEBHOOK_SECRET, redeploy, and open this link again.');
      if (env.adminIds.size === 0) todo.push('Set ADMIN_TELEGRAM_IDS (your id from @userinfobot), redeploy, and open this link again.');
      if (!env.groupConfigured) todo.push(`Add the bot to the ${env.COMMUNITY_TYPE} as an admin. It will message you the GROUP_CHAT_ID to set.`);
      if (rights && !rights.ok) todo.push(...rights.problems);
      if (!env.paystackEnabled) todo.push('Set PAYSTACK_SECRET_KEY and redeploy.');
      if (missingTrialVars.length > 0 && missingTrialVars.length < 4) {
        todo.push(`Free month is half set up. Still missing: ${missingTrialVars.join(', ')}.`);
      }
      if (freeMonth.enabled && !freeMonth.sourceReachable) {
        todo.push(`Free month: cannot read the source community (${String(freeMonth.error)}). Is the bot an admin there?`);
      }
      if (activePlans === 0) todo.push('No active plans on sale. Re-activate or add one in the bot: /admin -> Plans.');
      if (seededPlans.length) todo.push('Starter plans were created at placeholder prices. Set real prices: /admin -> Plans.');

      res
        .status(200)
        .type('application/json')
        .send(
          JSON.stringify(
            {
              ok: true,
              bot: `@${bot.botInfo.username}`,
              webhook: {
                url: info.url,
                pendingUpdates: info.pending_update_count,
                allowedUpdates: info.allowed_updates,
                lastError: info.last_error_message ?? null,
              },
              commandsPublishedForAdmins: env.adminIds.size,
              community: rights
                ? { type: rights.chatType, title: rights.title, rightsOk: rights.ok }
                : { configured: false, expectedType: env.COMMUNITY_TYPE },
              paystackConfigured: env.paystackEnabled,
              activePlans,
              seededPlans,
              freeMonth,
              stillToDo: todo.length ? todo : ['Nothing. Send /start to the bot.'],
            },
            null,
            2,
          ),
        );
    }),
  );
  app.post('/api/cron/run', cronHandler);

  /* ── Fallbacks ───────────────────────────────────────────── */

  app.use((req, res) => {
    res.status(404).json({ ok: false, error: 'Not found', path: req.path });
  });

  app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
    log.error('Unhandled request error', error);
    if (res.headersSent) return;
    res.status(500).json({ ok: false, error: 'Internal server error' });
  });

  return app;
}

/** Minimal styled page shown in the browser after a gateway redirect. */
function resultPage(heading: string, body: string, deepLink: string | null): string {
  const env = getEnv();
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(env.BRAND_NAME)} — ${escapeHtml(heading)}</title>
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #0f172a; color: #e2e8f0; padding: 24px;
  }
  .card {
    max-width: 420px; width: 100%; background: #1e293b; border-radius: 16px;
    padding: 32px 28px; text-align: center; box-shadow: 0 20px 50px rgba(0,0,0,.35);
  }
  h1 { font-size: 22px; margin: 0 0 12px; }
  p { margin: 0 0 24px; color: #94a3b8; }
  a.button {
    display: inline-block; background: #229ED9; color: #fff; text-decoration: none;
    padding: 14px 24px; border-radius: 10px; font-weight: 600;
  }
  .brand { margin-top: 24px; font-size: 13px; color: #64748b; }
</style>
</head>
<body>
  <div class="card">
    <h1>${escapeHtml(heading)}</h1>
    <p>${escapeHtml(body)}</p>
    ${deepLink ? `<a class="button" href="${escapeHtml(deepLink)}">Return to Telegram</a>` : ''}
    <div class="brand">${escapeHtml(env.BRAND_NAME)} — ${escapeHtml(env.GROUP_NAME)}</div>
  </div>
  ${deepLink ? `<script>setTimeout(function(){ location.href = ${JSON.stringify(deepLink)}; }, 2500);</script>` : ''}
</body>
</html>`;
}
