export interface BillingAccount {
  id: string;
  family_id: string;
  mode: 'TEST' | 'LIVE';
  merchant: string;
  customer_id: string | null;
  created_at: string;
  version: number;
  lease_token: string;
  quarantined: boolean;
  verified_at: string | null;
  alert: string | null;
}
export interface CheckoutParameters {
  price: string;
  origin: string;
  automaticTax: boolean;
  termsUrl: string;
  privacyUrl: string;
  policyUrl: string;
  approval: string;
}
export interface CheckoutAttempt {
  id: string;
  account_id: string;
  family_id: string;
  state: string;
  parameters: CheckoutParameters;
  session_id: string | null;
  url: string | null;
  expires_at: string | null;
  subscription_id: string | null;
  created_at: string;
}
export interface SubscriptionFacts {
  id: string;
  price: string;
  status: string;
  cancelAtPeriodEnd: boolean;
  cancelAt: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  trialEnd: string | null;
  invoiceId: string | null;
  invoiceStatus: string | null;
  paidThrough: string | null;
}
export interface StoredSubscription {
  provider_id: string;
  status: string;
  cancel_at_period_end: boolean;
  cancel_at: string | null;
  period_end: string | null;
  paid_through: string | null;
  verified_at: string;
  invoice_status: string | null;
}
export interface OwnerState {
  account: BillingAccount | null;
  attempt: CheckoutAttempt | null;
  subscriptions: StoredSubscription[];
  activation: boolean;
}
export interface InboxEvent {
  id: string;
  type: string;
  object_id: string | null;
  customer_id: string | null;
  attempts: number;
  lease_token: string;
}
