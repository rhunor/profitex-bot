/**
 * Money is stored everywhere in minor units (kobo for NGN) as an integer,
 * so arithmetic never touches floating point.
 */

export function toMajor(minor: number): number {
  return Math.round(minor) / 100;
}

export function toMinor(major: number): number {
  return Math.round(major * 100);
}

const SYMBOLS: Record<string, string> = {
  NGN: '₦',
  USD: '$',
  GHS: 'GH₵',
  KES: 'KSh',
  ZAR: 'R',
  GBP: '£',
  EUR: '€',
};

export function formatMoney(minor: number, currency = 'NGN'): string {
  const symbol = SYMBOLS[currency.toUpperCase()] ?? `${currency.toUpperCase()} `;
  const major = toMajor(minor);
  const formatted = major.toLocaleString('en-NG', {
    minimumFractionDigits: Number.isInteger(major) ? 0 : 2,
    maximumFractionDigits: 2,
  });
  return `${symbol}${formatted}`;
}

/** Parses "5000", "5,000", "5000.50", "₦5,000" into minor units. */
export function parseAmountToMinor(input: string): number | null {
  const cleaned = input.replace(/[^\d.]/g, '');
  if (!cleaned) return null;
  const value = Number(cleaned);
  if (!Number.isFinite(value) || value <= 0) return null;
  return toMinor(value);
}
