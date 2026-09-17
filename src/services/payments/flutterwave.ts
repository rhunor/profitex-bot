// FLUTTERWAVE-DISABLED: this adapter is complete and unit-tested but not
// registered. See src/services/payments/index.ts to switch it back on.
import { timingSafeEqual } from 'node:crypto';
import { getEnv } from '../../config/env';
import { requestJson } from '../../utils/http';
import { toMajor, toMinor } from '../../utils/money';
import type {
  CheckoutRequest,
  CheckoutResult,
  PaymentGateway,
  VerificationResult,
  WebhookParseResult,
} from './types';
import { GatewayError } from './types';

const BASE_URL = 'https://api.flutterwave.com/v3';

interface FlwEnvelope<T> {
  status: string;
  message: string;
  data: T;
}

interface FlwPaymentData {
  link: string;
}

interface FlwTransactionData {
  id: number;
  tx_ref: string;
  flw_ref?: string;
  amount: number;
  currency: string;
  charged_amount?: number;
  status: string;
  payment_type?: string;
  created_at?: string;
  processor_response?: string;
}

function authHeaders(): Record<string, string> {
  const key = getEnv().FLUTTERWAVE_SECRET_KEY;
  if (!key) throw new GatewayError('Flutterwave is not configured', 'flutterwave');
  return { Authorization: `Bearer ${key}` };
}

export const flutterwaveGateway: PaymentGateway = {
  id: 'flutterwave',
  label: 'Flutterwave',

  async createCheckout(request: CheckoutRequest): Promise<CheckoutResult> {
    const env = getEnv();
    const response = await requestJson<FlwEnvelope<FlwPaymentData>>(`${BASE_URL}/payments`, {
      method: 'POST',
      headers: authHeaders(),
      label: 'flutterwave:payments',
      body: {
        tx_ref: request.reference,
        // Flutterwave expects major units (naira), unlike Paystack.
        amount: toMajor(request.amountMinor),
        currency: request.currency,
        redirect_url: request.callbackUrl,
        customer: {
          email: request.email,
          name: request.customerName,
        },
        customizations: {
          title: `${env.BRAND_NAME} — ${request.planName}`,
          description: `${request.planName} access to ${env.GROUP_NAME}`,
        },
        configuration: {
          session_duration: 60,
          max_retry_attempt: 3,
        },
        meta: request.metadata ?? {},
      },
    });

    if (String(response?.status).toLowerCase() !== 'success' || !response.data?.link) {
      throw new GatewayError(response?.message || 'Flutterwave did not return a checkout link', 'flutterwave', response);
    }

    return { checkoutUrl: response.data.link };
  },

  async verify(reference: string, gatewayReference?: string): Promise<VerificationResult> {
    // Prefer verifying by the gateway's own transaction id when the webhook gave
    // us one; fall back to our reference for redirect-driven confirmations.
    const url = gatewayReference
      ? `${BASE_URL}/transactions/${encodeURIComponent(gatewayReference)}/verify`
      : `${BASE_URL}/transactions/verify_by_reference?tx_ref=${encodeURIComponent(reference)}`;

    let response: FlwEnvelope<FlwTransactionData>;
    try {
      response = await requestJson<FlwEnvelope<FlwTransactionData>>(url, {
        headers: authHeaders(),
        label: 'flutterwave:verify',
      });
    } catch (error) {
      const status = (error as { status?: number }).status;
      const body = (error as { body?: { message?: string } }).body;
      if (status === 404 || /no transaction was found/i.test(body?.message ?? '')) {
        return { status: 'not_found', amountMinor: 0, currency: '', raw: body ?? error, reason: 'Transaction not found' };
      }
      throw new GatewayError('Could not reach Flutterwave to verify the payment', 'flutterwave', error);
    }

    const data = response?.data;
    if (String(response?.status).toLowerCase() !== 'success' || !data) {
      return { status: 'not_found', amountMinor: 0, currency: '', raw: response, reason: response?.message };
    }

    const raw = String(data.status || '').toLowerCase();
    const status = raw === 'successful' ? 'success' : raw === 'pending' ? 'pending' : 'failed';

    return {
      status,
      amountMinor: toMinor(Number(data.amount ?? 0)),
      currency: String(data.currency ?? ''),
      gatewayReference: String(data.id ?? ''),
      channel: data.payment_type,
      paidAt: data.created_at ? new Date(data.created_at) : undefined,
      reason: data.processor_response,
      raw: data,
    };
  },

  verifyWebhookSignature(_rawBody: Buffer, headers: Record<string, string | string[] | undefined>): boolean {
    // Flutterwave does not sign the body; it echoes the secret hash you configure
    // on the dashboard in a `verif-hash` header.
    const expected = getEnv().FLUTTERWAVE_SECRET_HASH;
    if (!expected) return false;

    const headerValue = headers['verif-hash'] ?? headers['verif_hash'];
    const provided = Array.isArray(headerValue) ? headerValue[0] : headerValue;
    if (!provided) return false;

    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(provided, 'utf8');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  },

  parseWebhook(payload: unknown): WebhookParseResult {
    const body = payload as {
      event?: string;
      'event.type'?: string;
      data?: { tx_ref?: string; txRef?: string; id?: number | string; status?: string };
      txRef?: string;
      id?: number | string;
    };

    const event = body?.event ?? body?.['event.type'];
    const reference = body?.data?.tx_ref ?? body?.data?.txRef ?? body?.txRef;
    const gatewayReference = body?.data?.id ?? body?.id;
    const status = String(body?.data?.status ?? '').toLowerCase();

    const actionable = Boolean(reference) && (event === 'charge.completed' || !event) && status === 'successful';

    return {
      actionable,
      event,
      reference: reference ? String(reference) : undefined,
      gatewayReference: gatewayReference !== undefined ? String(gatewayReference) : undefined,
    };
  },
};
