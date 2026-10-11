import { resolveMembership } from '../access/access.service.js';
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
  if (!m)
    return {
      state: resolved.state === 'REVOKED' ? 'REVOKED' : 'NO_ACCESS',
      user,
      family: null,
      membership: null,
      capabilities: [],
    };
  const { data: household, error } = await (
    await import('../../config/supabase.js')
  )
    .getServiceRoleClient()
    .from('families')
    .select('responsible_user_id')
    .eq('id', m.family_id)
    .single();
  if (error) throw error;
  const { family, responsible } = await loadFamilyAndResponsible(
    m.family_id,
    household.responsible_user_id,
  );
  return {
    state:
      responsible.name && responsible.relationship
        ? 'READY'
        : 'ONBOARDING_REQUIRED',
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
      m.role === 'MEMBER'
        ? [
            'family:read',
            'board:read',
            'points:self',
            'leaderboard:read',
            'awards:read',
          ]
        : [
            'family:read',
            'family:manage',
            'members:manage',
            'tasks:manage',
            'templates:manage',
            'points:all',
            'awards:manage',
            ...(m.role === 'OWNER' ? ['owner:onboarding'] : []),
          ],
  };
}
