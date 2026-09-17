/**
 * Vercel serverless entry point.
 *
 * `vercel.json` rewrites every path to this function, so the Express app in
 * src/http/app.ts serves the Telegram webhook, both payment webhooks, the
 * checkout redirect and the cron endpoint from a single deployment.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createApp } from '../src/http/app';

const app = createApp();

export default function handler(req: IncomingMessage, res: ServerResponse): void {
  // Express apps are plain (req, res) handlers.
  (app as unknown as (request: IncomingMessage, response: ServerResponse) => void)(req, res);
}
