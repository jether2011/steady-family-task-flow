export type AccessRole = 'OWNER' | 'MANAGER' | 'MEMBER';
export interface MembershipRow {
  id: string;
  family_id: string;
  app_user_id: string | null;
  member_id: string | null;
  role: AccessRole;
  status: 'PROVISIONED' | 'ACTIVE' | 'REVOKED';
  login_email: string | null;
  access_version: number;
}
export interface Resolution {
  state: 'READY' | 'NO_ACCESS' | 'REVOKED';
  user: {
    id: string;
    auth_user_id: string;
    display_name: string | null;
    avatar_url: string | null;
  };
  membership: MembershipRow | null;
}
export function accessSummary(m: MembershipRow | null) {
  return m
    ? {
        membershipId: m.id,
        email: m.login_email,
        role: m.role,
        status: m.status,
        accessVersion: m.access_version,
      }
    : null;
}
