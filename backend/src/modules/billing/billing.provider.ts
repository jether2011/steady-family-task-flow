import Stripe from 'stripe';
import { billingSettings } from './billing.config.js';
import { env } from '../../config/env.js';
import { AppError } from '../../shared/errors/index.js';
export const STRIPE_API_VERSION = '2026-09-30.endive' as const;
let client: Stripe | undefined;
export function stripeClient() {
  if (!env.STRIPE_SECRET_KEY)
    throw new AppError('BILLING_UNAVAILABLE', 503, 'Billing is not configured');
  return (client ??= new Stripe(env.STRIPE_SECRET_KEY, {
    apiVersion: STRIPE_API_VERSION,
    timeout: 10000,
    maxNetworkRetries: 1,
  }));
}
export function billingUnavailable() {
  return new AppError(
    'BILLING_UNAVAILABLE',
    503,
    'Billing is temporarily unavailable. Please recheck shortly.',
  );
}
export function providerUrl(value: string | null, kind: 'checkout' | 'portal') {
  try {
    const url = new URL(value ?? '');
    if (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      url.hostname ===
        (kind === 'checkout' ? 'checkout.stripe.com' : 'billing.stripe.com')
    )
      return url.href;
  } catch {
    /* reject provider URL */
  }
  throw billingUnavailable();
}
export function commercialConfig() {
  return billingSettings() !== null;
}
export async function verifyMerchant() {
  const account = await stripeClient().accounts.retrieve(null);
  if (
    account.id !== env.STRIPE_ACCOUNT_ID ||
    (env.STRIPE_MERCHANT_COUNTRY &&
      account.country !== env.STRIPE_MERCHANT_COUNTRY)
  )
    throw billingUnavailable();
  return account;
}
export async function approvedPlan() {
  const settings = billingSettings();
  if (!settings) return null;
  try {
    await verifyMerchant();
    const price = await stripeClient().prices.retrieve(env.STRIPE_PRICE_ID!, {
      expand: ['product'],
    });
    const product = price.product;
    if (
      price.id !== settings.priceId ||
      !price.active ||
      price.livemode !== (env.STRIPE_MODE === 'LIVE') ||
      price.type !== 'recurring' ||
      price.recurring?.interval !== 'month' ||
      price.recurring.interval_count !== 1 ||
      price.recurring.usage_type !== 'licensed' ||
      price.billing_scheme !== 'per_unit' ||
      !price.unit_amount ||
      price.currency !== env.BILLING_CURRENCY ||
      price.tax_behavior !== env.BILLING_TAX_BEHAVIOR ||
      typeof product === 'string' ||
      product.deleted ||
      !product.active
    )
      throw billingUnavailable();
    const portal = await stripeClient().billingPortal.configurations.retrieve(
      env.STRIPE_PORTAL_CONFIGURATION_ID!,
    );
    if (
      !portal.active ||
      portal.livemode !== (env.STRIPE_MODE === 'LIVE') ||
      !portal.features.subscription_cancel.enabled ||
      portal.features.subscription_cancel.mode !== 'at_period_end' ||
      portal.features.subscription_update.enabled ||
      !portal.features.payment_method_update.enabled ||
      !portal.features.invoice_history.enabled ||
      portal.business_profile.terms_of_service_url !== env.BILLING_TERMS_URL ||
      portal.business_profile.privacy_policy_url !== env.BILLING_PRIVACY_URL
    )
      throw billingUnavailable();
    return {
      planKey: 'family-monthly' as const,
      title: settings.title,
      currency: price.currency,
      unitAmount: price.unit_amount,
      interval: 'month' as const,
      features: settings.features,
      memberLimit: settings.memberLimit,
      termsUrl: env.BILLING_TERMS_URL!,
      privacyUrl: env.BILLING_PRIVACY_URL!,
      policyUrl: env.BILLING_POLICY_URL!,
      taxDisclosure: env.BILLING_TAX_DISCLOSURE!,
      available: env.BILLING_AVAILABLE && env.CHECKOUT_ENABLED,
    };
  } catch {
    throw billingUnavailable();
  }
}
export const refId = (value: string | { id: string } | null | undefined) =>
  typeof value === 'string' ? value : (value?.id ?? null);
export const iso = (value: number | null | undefined) =>
  value ? new Date(value * 1000).toISOString() : null;
