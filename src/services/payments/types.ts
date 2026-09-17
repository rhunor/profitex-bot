import type { Gateway } from '../../models/types';

export interface CheckoutRequest {
  /** Our reference. Always created before the subscriber leaves for the gateway. */
  reference: string;
  amountMinor: number;
  currency: string;
  email: string;
  customerName: string;
  planName: string;
  /** Where the gateway sends the browser once the payment flow ends. */
  callbackUrl: string;
  metadata?: Record<string, unknown>;
}

export interface CheckoutResult {
  checkoutUrl: string;
  gatewayReference?: string;
}

export type NormalisedStatus = 'success' | 'failed' | 'pending' | 'not_found';

export interface VerificationResult {
  status: NormalisedStatus;
  amountMinor: number;
  currency: string;
  gatewayReference?: string;
  channel?: string;
  paidAt?: Date;
  reason?: string;
  raw: unknown;
}

export interface WebhookParseResult {
  /** True when the payload is an event we act on (a completed charge). */
  actionable: boolean;
  reference?: string;
  gatewayReference?: string;
  event?: string;
}

export interface PaymentGateway {
  readonly id: Gateway;
  readonly label: string;
  createCheckout(request: CheckoutRequest): Promise<CheckoutResult>;
  /** Server-to-server confirmation. Never trust a redirect or a webhook body alone. */
  verify(reference: string, gatewayReference?: string): Promise<VerificationResult>;
  verifyWebhookSignature(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): boolean;
  parseWebhook(payload: unknown): WebhookParseResult;
}

export class GatewayError extends Error {
  constructor(
    message: string,
    readonly gateway: Gateway,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'GatewayError';
  }
}
