import { env } from '../../config/env.js';
/** Approved commercial settings. No secret material or invented price/cap defaults. */
export function billingSettings() {
  const {
    STRIPE_ACCOUNT_ID: merchant,
    STRIPE_MERCHANT_COUNTRY: country,
    STRIPE_PRICE_ID: priceId,
    STRIPE_PORTAL_CONFIGURATION_ID: portalId,
    PUBLIC_APP_URL: origin,
    BILLING_PLAN_TITLE: title,
    BILLING_PLAN_FEATURES: featureText,
    BILLING_MEMBER_LIMIT: limit,
    BILLING_CURRENCY: currency,
    BILLING_TAX_BEHAVIOR: taxBehavior,
    BILLING_AUTOMATIC_TAX: tax,
    BILLING_PAYMENT_METHODS: methods,
    BILLING_TERMS_URL: termsUrl,
    BILLING_PRIVACY_URL: privacyUrl,
    BILLING_POLICY_URL: policyUrl,
    BILLING_TAX_DISCLOSURE: taxDisclosure,
    BILLING_APPROVAL_REFERENCE: approvalReference,
  } = env;
  if (
    !env.STRIPE_SECRET_KEY ||
    !merchant ||
    !country ||
    !priceId ||
    !portalId ||
    !origin ||
    !title ||
    !featureText ||
    !limit ||
    !currency ||
    !taxBehavior ||
    !tax ||
    methods !== 'card' ||
    !termsUrl ||
    !privacyUrl ||
    !policyUrl ||
    !taxDisclosure ||
    !approvalReference
  )
    return null;
  const features = featureText
    .split('|')
    .map((v) => v.trim())
    .filter(Boolean);
  if (!features.length) return null;
  return Object.freeze({
    merchant,
    country,
    priceId,
    portalId,
    origin: new URL(origin).origin,
    title,
    currency,
    features,
    memberLimit: limit === 'unlimited' ? null : Number(limit),
    taxBehavior,
    automaticTax: tax === 'true',
    paymentMethods: ['card'] as const,
    termsUrl,
    privacyUrl,
    policyUrl,
    taxDisclosure,
    approvalReference,
  });
}
