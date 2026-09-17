export const GATEWAYS = ['paystack', 'flutterwave'] as const;
export type Gateway = (typeof GATEWAYS)[number];

export const PAYMENT_STATUSES = ['pending', 'success', 'failed', 'abandoned'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const SUBSCRIPTION_STATUSES = ['active', 'expired', 'revoked'] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const INVITE_STATUSES = ['active', 'used', 'revoked', 'expired'] as const;
export type InviteStatus = (typeof INVITE_STATUSES)[number];

export const REMINDER_KEYS = ['d7', 'd3', 'h24'] as const;
export type ReminderKey = (typeof REMINDER_KEYS)[number];

export const BROADCAST_AUDIENCES = ['all', 'active', 'expired'] as const;
export type BroadcastAudience = (typeof BROADCAST_AUDIENCES)[number];

export const BROADCAST_STATUSES = ['queued', 'running', 'done', 'cancelled'] as const;
export type BroadcastStatus = (typeof BROADCAST_STATUSES)[number];
