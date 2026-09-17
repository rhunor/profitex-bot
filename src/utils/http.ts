import { createLogger } from './logger';
import { sleep } from './time';

const log = createLogger('http');

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export interface RequestJsonOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  /** Retries for network errors, 429s and 5xx. */
  retries?: number;
  label?: string;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * JSON HTTP client with timeout + bounded exponential backoff.
 * Gateway calls must never hang a serverless invocation or a bot update.
 */
export async function requestJson<T = unknown>(url: string, options: RequestJsonOptions = {}): Promise<T> {
  const { method = 'GET', headers = {}, body, timeoutMs = 20_000, retries = 2, label = url } = options;

  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method,
        headers: {
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });

      const text = await response.text();
      let parsed: unknown = null;
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
      }

      if (!response.ok) {
        if (RETRYABLE_STATUS.has(response.status) && attempt < retries) {
          const wait = 500 * 2 ** attempt;
          log.warn(`${label} responded ${response.status}, retrying in ${wait}ms`, { attempt });
          await sleep(wait);
          continue;
        }
        throw new HttpError(`${label} failed with HTTP ${response.status}`, response.status, parsed);
      }

      return parsed as T;
    } catch (error) {
      lastError = error;
      const isAbort = error instanceof Error && error.name === 'AbortError';
      const isHttp = error instanceof HttpError;
      if (isHttp) throw error;
      if (attempt < retries) {
        const wait = 500 * 2 ** attempt;
        log.warn(`${label} ${isAbort ? 'timed out' : 'errored'}, retrying in ${wait}ms`, { attempt });
        await sleep(wait);
        continue;
      }
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`${label} failed`);
}
