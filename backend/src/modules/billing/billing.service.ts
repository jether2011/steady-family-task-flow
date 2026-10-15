import { runAccount } from './billing.worker.js';
import { createHash } from 'node:crypto';
import { env } from '../../config/env.js';
import { billingRpc as accessRpc } from './billing.repository.js';
import { getServiceRoleClient } from '../../config/supabase.js';
import { AppError } from '../../shared/errors/index.js';
import {
  approvedPlan,
  billingUnavailable,
  providerUrl,
  stripeClient,
  verifyMerchant,
} from './billing.provider.js';
import type { CheckoutAttempt, OwnerState } from './billing.types.js';
export async function ownerState(
  auth: string,
  family: string,
  attempt?: string,
) {
  return accessRpc<OwnerState>('billing_owner_state', {
    p_auth: auth,
    p_family: family,
    p_mode: env.STRIPE_MODE,
    ...(attempt ? { p_attempt: attempt } : {}),
  });
}
export async function checkout(
  auth: string,
  family: string,
  key: string,
  correlation: string,
) {
  // Authorize in the reserve transaction as well as middleware; no external HTTP under locks.
  if (!env.BILLING_AVAILABLE || !env.CHECKOUT_ENABLED)
    throw billingUnavailable();
  const plan = await approvedPlan();
  if (!plan?.available)
    throw new AppError(
      'PLAN_UNAVAILABLE',
      422,
      'The approved monthly plan is not available',
    );
  const result = await accessRpc<{
    attempt?: CheckoutAttempt;
    created?: boolean;
    processing?: boolean;
  }>('billing_reserve', {
    p_auth: auth,
    p_family: family,
    p_key: key,
    p_hash: createHash('sha256').update('family-monthly').digest('hex'),
    p_mode: env.STRIPE_MODE,
    p_merchant: env.STRIPE_ACCOUNT_ID,
    p_parameters: {
      price: env.STRIPE_PRICE_ID,
      origin: new URL(env.PUBLIC_APP_URL!).origin,
      automaticTax: env.BILLING_AUTOMATIC_TAX === 'true',
      termsUrl: env.BILLING_TERMS_URL,
      privacyUrl: env.BILLING_PRIVACY_URL,
      policyUrl: env.BILLING_POLICY_URL,
      approval: env.BILLING_APPROVAL_REFERENCE,
    },
    p_correlation: correlation,
  });
  // The durable worker owns creation. HTTP retries only observe the reserved operation.
  let t = result.attempt;
  if (t && ['CREATING', 'UNKNOWN'].includes(t.state)) {
    await runAccount(t.account_id);
    t = (await ownerState(auth, family, t.id)).attempt ?? t;
  }
  return t?.state === 'OPEN' && t.url
    ? {
        status: result.created ? (201 as const) : (200 as const),
        body: {
          attemptId: t.id,
          url: providerUrl(t.url, 'checkout'),
          expiresAt: t.expires_at,
        },
      }
    : {
        status: 202 as const,
        body: { attemptId: t?.id ?? null, state: 'PROCESSING' as const },
      };
}
export async function portal(
  auth: string,
  family: string,
  correlation: string,
) {
  const state = await ownerState(auth, family);
  const account = state.account;
  if (
    !account?.customer_id ||
    account.merchant !== env.STRIPE_ACCOUNT_ID ||
    !env.STRIPE_PORTAL_CONFIGURATION_ID ||
    !env.PUBLIC_APP_URL
  )
    throw billingUnavailable();
  try {
    await verifyMerchant();
    // Recovery remains available with CHECKOUT_ENABLED=false. Revalidate the portal policy separately.
    const config = await stripeClient().billingPortal.configurations.retrieve(
      env.STRIPE_PORTAL_CONFIGURATION_ID,
    );
    if (
      !config.active ||
      config.livemode !== (env.STRIPE_MODE === 'LIVE') ||
      config.features.subscription_update.enabled ||
      !config.features.subscription_cancel.enabled ||
      config.features.subscription_cancel.mode !== 'at_period_end'
    )
      throw billingUnavailable();
    const session = await stripeClient().billingPortal.sessions.create({
      customer: account.customer_id,
      configuration: config.id,
      return_url: new URL('/billing', env.PUBLIC_APP_URL).href,
    });
    const { error } = await getServiceRoleClient()
      .from('billing_audit_events')
      .insert({
        family_id: family,
        operation: 'PORTAL',
        result: 'CREATED',
        correlation_id: correlation,
      });
    if (error) throw billingUnavailable();
    return { url: providerUrl(session.url, 'portal') };
  } catch {
    throw billingUnavailable();
  }
}
export function checkoutStatus(state: OwnerState) {
  const t = state.attempt!;
  const failed = ['EXPIRED', 'FAILED', 'CLOSED'].includes(t.state);
  return {
    attemptId: t.id,
    state: t.state,
    activation: failed
      ? ('FAILED' as const)
      : state.activation
        ? ('CONFIRMED' as const)
        : ('PENDING' as const),
    nextAction: state.activation
      ? 'OPEN_DASHBOARD'
      : failed
        ? 'RETRY_CHECKOUT'
        : state.account?.quarantined
          ? 'CONTACT_SUPPORT'
          : 'WAIT',
    ...(t.state === 'OPEN' && t.url
      ? { url: providerUrl(t.url, 'checkout') }
      : {}),
  };
}
