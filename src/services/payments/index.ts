import { getEnv } from '../../config/env';
import type { Gateway } from '../../models/types';
// FLUTTERWAVE-DISABLED: Paystack only for launch. To re-enable Flutterwave,
// search the project for FLUTTERWAVE-DISABLED and uncomment each marked line.
// The adapter in ./flutterwave.ts is untouched and still tested.
// import { flutterwaveGateway } from './flutterwave';
import { paystackGateway } from './paystack';
import type { PaymentGateway } from './types';

const REGISTRY: Partial<Record<Gateway, PaymentGateway>> = {
  paystack: paystackGateway,
  // flutterwave: flutterwaveGateway, // FLUTTERWAVE-DISABLED
};

export function getGateway(id: Gateway): PaymentGateway {
  const gateway = REGISTRY[id];
  if (!gateway) throw new Error(`Payment gateway is not available: ${id}`);
  return gateway;
}

/** Only the gateways that actually have credentials configured. */
export function enabledGateways(): PaymentGateway[] {
  const env = getEnv();
  const list: PaymentGateway[] = [];
  if (env.paystackEnabled) list.push(paystackGateway);
  // if (env.flutterwaveEnabled) list.push(flutterwaveGateway); // FLUTTERWAVE-DISABLED
  return list;
}

export function isGatewayEnabled(id: Gateway): boolean {
  return enabledGateways().some((g) => g.id === id);
}

export * from './types';
export { paystackGateway };
// export { flutterwaveGateway }; // FLUTTERWAVE-DISABLED
