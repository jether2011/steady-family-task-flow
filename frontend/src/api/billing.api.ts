import { get, post, request } from './client';
export interface BillingPlan {
  planKey: 'family-monthly';
  title: string | null;
  currency: string | null;
  unitAmount: number | null;
  interval: 'month';
  features: string[];
  memberLimit: number | null;
  termsUrl: string | null;
  privacyUrl: string | null;
  policyUrl: string | null;
  taxDisclosure: string | null;
  available: boolean;
}
export interface BillingSubscription {
  entitlement?: {
    state: string;
    effectiveUntil: string | null;
    ownerDeadlines?: Record<string, unknown> | null;
  } | null;
  plan: BillingPlan | null;
  status: string | null;
  cancelAtPeriodEnd: boolean;
  paidThrough: string | null;
  nextBillingAt: string | null;
  accessState: string;
  recoveryAction: string;
  updatedAt: string | null;
  attemptId: string | null;
}
export interface CheckoutStatus {
  attemptId: string;
  state: string;
  activation: 'PENDING' | 'CONFIRMED' | 'FAILED';
  nextAction: string;
  url?: string;
}
export const billing = {
  plan: (signal?: AbortSignal) =>
    get<BillingPlan>('/billing/plan', undefined, signal),
  subscription: (signal?: AbortSignal) =>
    get<BillingSubscription>('/billing/subscription', undefined, signal),
  checkout: (key: string) =>
    request<{
      attemptId: string | null;
      state?: 'PROCESSING';
      url?: string;
      expiresAt?: string | null;
    }>('POST', '/billing/checkout', {
      body: { planKey: 'family-monthly' },
      headers: { 'Idempotency-Key': key },
    }),
  attempt: (id: string, signal?: AbortSignal) =>
    get<CheckoutStatus>(
      '/billing/checkout/' + encodeURIComponent(id),
      undefined,
      signal,
    ),
  portal: () => post<{ url: string }>('/billing/portal', {}),
};
export function hostedBillingUrl(value: string, kind: 'checkout' | 'portal') {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hostname !==
      (kind === 'checkout' ? 'checkout.stripe.com' : 'billing.stripe.com')
  )
    throw new Error('Invalid billing destination');
  return url.href;
}
