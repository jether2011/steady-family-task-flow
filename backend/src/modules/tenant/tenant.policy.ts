/** Temporary legacy compatibility policy; SELF_SERVICE never implies entitlement. */
export function tenantState(tenant: {
  lifecycle: string;
  creation_source: string;
  legacy_access_eligible: boolean;
  profile_completed_at: string | null;
}): 'READY' | 'ONBOARDING_REQUIRED' | 'PAYMENT_REQUIRED' {
  if (!tenant.profile_completed_at) return 'ONBOARDING_REQUIRED';
  return tenant.lifecycle === 'ESTABLISHED' &&
    tenant.creation_source === 'LEGACY' &&
    tenant.legacy_access_eligible
    ? 'READY'
    : 'PAYMENT_REQUIRED';
}
