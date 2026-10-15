import { resolveEntitlement } from '../entitlements/entitlements.service.js';
import { env } from '../../config/env.js';
import { accessRpc } from '../access/access.repository.js';
import {
  resolveMembership,
  verifiedIdentity,
} from '../access/access.service.js';
import { loadFamilyAndResponsible } from '../family/family.repository.js';
import type { AuthClaims } from '../../middleware/types.js';
import type { MePayload } from '../../shared/types/index.js';
export async function bootstrapMe(
  authUserId: string,
  _claims: AuthClaims,
): Promise<MePayload> {
  const resolved = await resolveMembership(authUserId);
  const user = {
    id: resolved.user.id,
    displayName: resolved.user.display_name,
    avatarUrl: resolved.user.avatar_url,
  };
  const m = resolved.membership;
  if (!m) {
    const signupAvailable =
      resolved.state !== 'REVOKED' &&
      env.SELF_SERVICE_SIGNUP_ENABLED &&
      (await accessRpc<boolean>('tenant_signup_eligible', {
        p_auth: authUserId,
        p_email: (await verifiedIdentity(authUserId)).email,
      }));
    return {
      state: resolved.state === 'REVOKED' ? 'REVOKED' : 'NO_ACCESS',
      user,
      family: null,
      membership: null,
      capabilities: [],
      signupAvailable,
    };
  }
  const { data: household, error } = await (
    await import('../../config/supabase.js')
  )
    .getServiceRoleClient()
    .from('families')
    .select(
      'responsible_user_id,lifecycle,creation_source,legacy_access_eligible,profile_completed_at',
    )
    .eq('id', m.family_id)
    .single();
  if (error) throw error;
  const { family, responsible } = await loadFamilyAndResponsible(
    m.family_id,
    household.responsible_user_id,
  );
  const entitlement = await resolveEntitlement(authUserId, m.family_id);
  const state = !household.profile_completed_at
    ? 'ONBOARDING_REQUIRED'
    : entitlement.canRead
      ? 'READY'
      : 'PAYMENT_REQUIRED';
  return {
    state,
    access: {
      state: entitlement.state,
      reason: entitlement.reason,
      effectiveUntil: entitlement.effectiveUntil,
      version: entitlement.version,
      canManageBilling: m.role === 'OWNER',
    },
    user,
    family: {
      id: family.id,
      name: family.name,
      avatar_url: family.avatar_url,
      relationship: responsible.relationship,
      responsible_name: responsible.name,
    },
    membership: {
      id: m.id,
      role: m.role,
      memberId: m.member_id,
      accessVersion: m.access_version,
    },
    capabilities:
      state !== 'READY'
        ? m.role === 'OWNER'
          ? ['owner:onboarding', 'billing:manage']
          : []
        : m.role === 'MEMBER'
          ? [
              ...(env.MEMBER_VIEWS_ENABLED ? ['member:views'] : []),
              'family:read',
              'board:read',
              'points:self',
              'leaderboard:read',
              'awards:read',
            ]
          : [
              'family:read',
              'members:read',
              'templates:read',
              'members:security-revoke',
              ...(entitlement.canWrite
                ? [
                    'family:manage',
                    'members:manage',
                    'tasks:manage',
                    'templates:manage',
                    'awards:manage',
                  ]
                : []),
              'points:all',
              ...(m.role === 'OWNER'
                ? ['owner:onboarding', 'billing:manage']
                : []),
            ],
  };
}
