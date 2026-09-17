import { createHmac, timingSafeEqual } from 'node:crypto';
import { getEnv } from '../../config/env';
import { createLogger } from '../../utils/logger';
import { requestJson } from '../../utils/http';
import type {
  CheckoutRequest,
  CheckoutResult,
  PaymentGateway,
  VerificationResult,
  WebhookParseResult,
} from './types';
import { GatewayError } from './types';

const log = createLogger('paystack');
const BASE_URL = 'https://api.paystack.co';

interface PaystackEnvelope<T> {
  status: boolean;
  message: string;
  data: T;
}

interface InitialiseData {
  authorization_url: string;
  access_code: string;
  reference: string;
}

interface TransactionData {
  id: number;
  status: string;
  reference: string;
  amount: number;
  currency: string;
  channel?: string;
  paid_at?: string | null;
  gateway_response?: string;
}

function authHeaders(): Record<string, string> {
  const key = getEnv().PAYSTACK_SECRET_KEY;
  if (!key) throw new GatewayError('Paystack is not configured', 'paystack');
  return { Authorization: `Bearer ${key}` };
}

export const paystackGateway: PaymentGateway = {
  id: 'paystack',
  label: 'Paystack',

  async createCheckout(request: CheckoutRequest): Promise<CheckoutResult> {
    const response = await requestJson<PaystackEnvelope<InitialiseData>>(`${BASE_URL}/transaction/initialize`, {
      method: 'POST',
      headers: authHeaders(),
      label: 'paystack:initialize',
      body: {
        email: request.email,
        // Paystack expects the amount in the currency's subunit (kobo for NGN).
        amount: request.amountMinor,
        currency: request.currency,
        reference: request.reference,
        callback_url: request.callbackUrl,
        metadata: {
          ...request.metadata,
          plan: request.planName,
          custom_fields: [
            { display_name: 'Plan', variable_name: 'plan', value: request.planName },
            { display_name: 'Subscriber', variable_name: 'subscriber', value: request.customerName },
          ],
        },
      },
    });

    if (!response?.status || !response.data?.authorization_url) {
      throw new GatewayError(response?.message || 'Paystack did not return a checkout link', 'paystack', response);
    }

    return { checkoutUrl: response.data.authorization_url, gatewayReference: response.data.reference };
  },

  async verify(reference: string): Promise<VerificationResult> {
    let response: PaystackEnvelope<TransactionData>;
    try {
      response = await requestJson<PaystackEnvelope<TransactionData>>(
        `${BASE_URL}/transaction/verify/${encodeURIComponent(reference)}`,
        { headers: authHeaders(), label: 'paystack:verify' },
      );
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status === 404) {
        return { status: 'not_found', amountMinor: 0, currency: '', raw: error, reason: 'Transaction not found' };
      }
      throw new GatewayError('Could not reach Paystack to verify the payment', 'paystack', error);
    }

    const data = response?.data;
    if (!response?.status || !data) {
      return { status: 'not_found', amountMinor: 0, currency: '', raw: response, reason: response?.message };
    }

    const raw = String(data.status || '').toLowerCase();
    const status =
      raw === 'success' ? 'success' : ['ongoing', 'pending', 'processing'].includes(raw) ? 'pending' : 'failed';

    return {
      status,
      amountMinor: Number(data.amount ?? 0),
      currency: String(data.currency ?? ''),
      gatewayReference: String(data.id ?? data.reference ?? ''),
      channel: data.channel,
      paidAt: data.paid_at ? new Date(data.paid_at) : undefined,
      reason: data.gateway_response,
      raw: data,
    };
  },

  verifyWebhookSignature(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): boolean {
    const secret = getEnv().PAYSTACK_SECRET_KEY;
    if (!secret) return false;

    const headerValue = headers['x-paystack-signature'];
    const provided = Array.isArray(headerValue) ? headerValue[0] : headerValue;
    if (!provided) return false;

    // HMAC-SHA512 of the *raw* body, keyed with the secret key, hex encoded.
    const expected = createHmac('sha512', secret).update(rawBody).digest('hex');
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(provided, 'utf8');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  },

  parseWebhook(payload: unknown): WebhookParseResult {
    const body = payload as { event?: string; data?: { reference?: string; id?: number | string; status?: string } };
    const event = body?.event;
    const reference = body?.data?.reference;

    // `charge.success` is the only event that grants access. Everything else is
    // acknowledged with 200 so Paystack stops retrying, but changes nothing.
    const actionable = event === 'charge.success' && Boolean(reference);

    return {
      actionable,
      event,
      reference,
      gatewayReference: body?.data?.id !== undefined ? String(body.data.id) : undefined,
    };
  },
};

export { log as paystackLogger };
