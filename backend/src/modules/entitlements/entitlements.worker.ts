import { env } from '../../config/env.js';
import { accessRpc } from '../access/access.repository.js';
export function configuredEntitlementPolicy() {
  if (
    !env.ENTITLEMENT_POLICY_VERSION ||
    !env.ENTITLEMENT_POLICY_APPROVAL ||
    env.RENEWAL_GRACE_DAYS === undefined ||
    env.PROVIDER_OUTAGE_TOLERANCE_HOURS === undefined ||
    !env.ENTITLEMENT_EXCEPTION_POLICY ||
    !env.STRIPE_ACCOUNT_ID ||
    !env.STRIPE_PRICE_ID ||
    !env.BILLING_MEMBER_LIMIT
  )
    return null;
  return {
    version: env.ENTITLEMENT_POLICY_VERSION,
    approval: env.ENTITLEMENT_POLICY_APPROVAL,
    enforcementEnabled: env.ENTITLEMENT_ENFORCEMENT_ENABLED,
    graceDays: env.RENEWAL_GRACE_DAYS,
    outageHours: env.PROVIDER_OUTAGE_TOLERANCE_HOURS,
    trialsEnabled: env.ENTITLEMENT_TRIALS_ENABLED,
    legacyDeadline: env.LEGACY_ENTITLEMENT_DEADLINE ?? null,
    mode: env.STRIPE_MODE,
    merchant: env.STRIPE_ACCOUNT_ID,
    priceId: env.STRIPE_PRICE_ID,
    exceptionPolicy: env.ENTITLEMENT_EXCEPTION_POLICY,
    memberLimit:
      env.BILLING_MEMBER_LIMIT && env.BILLING_MEMBER_LIMIT !== 'unlimited'
        ? Number(env.BILLING_MEMBER_LIMIT)
        : null,
  };
}
export async function publishEntitlementPolicy() {
  const policy = configuredEntitlementPolicy();
  if (policy) await accessRpc('entitlement_configure', { p: policy });
}
export async function projectEntitlements() {
  const job = await accessRpc<{
    family_id: string;
    lease_token: string;
  } | null>('entitlement_claim', {});
  if (!job) return false;
  try {
    await accessRpc('entitlement_project', {
      p_family: job.family_id,
      p_token: job.lease_token,
    });
  } catch {
    await accessRpc('entitlement_retry', {
      p_family: job.family_id,
      p_token: job.lease_token,
    });
  }
  return true;
}
