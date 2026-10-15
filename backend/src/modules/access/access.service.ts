import { createHash, randomBytes } from 'node:crypto';
import { getServiceRoleClient } from '../../config/supabase.js';
import { env } from '../../config/env.js';
import { AppError, Unauthorized } from '../../shared/errors/index.js';
import { accessRpc } from './access.repository.js';
import type { Resolution, MembershipRow } from './access.types.js';
import { mutationIdentity } from './access.store.js';
export async function verifiedIdentity(authUserId: string) {
  const { data, error } =
    await getServiceRoleClient().auth.admin.getUserById(authUserId);
  if (error)
    throw new AppError(
      'IDENTITY_UNAVAILABLE',
      503,
      'Sign-in verification is temporarily unavailable',
    );
  if (!data.user || data.user.id !== authUserId) throw new Unauthorized();
  return {
    email: data.user.email_confirmed_at ? (data.user.email ?? null) : null,
    name:
      typeof data.user.user_metadata?.name === 'string'
        ? data.user.user_metadata.name
        : null,
    avatar:
      typeof data.user.user_metadata?.avatar_url === 'string'
        ? data.user.user_metadata.avatar_url
        : null,
  };
}
export async function resolveMembership(
  authUserId: string,
): Promise<Resolution> {
  const identity = await verifiedIdentity(authUserId);
  return accessRpc<Resolution>('resolve_membership', {
    p_auth: authUserId,
    p_email: identity.email,
    p_name: identity.name,
    p_avatar: identity.avatar,
    p_claim: env.MEMBERSHIP_ACCESS_ENABLED,
  });
}
export async function readMemberAccess(
  memberId: string,
): Promise<MembershipRow | null> {
  const actor = mutationIdentity();
  const db = getServiceRoleClient();
  const { data: member, error: memberError } = await db
    .from('family_members')
    .select('id')
    .eq('id', memberId)
    .eq('family_id', actor.family)
    .maybeSingle();
  if (memberError) throw memberError;
  if (!member) throw new AppError('NOT_FOUND', 404, 'Resource not found');
  const { data, error } = await db
    .from('family_memberships')
    .select(
      'id,family_id,app_user_id,member_id,role,status,login_email,access_version',
    )
    .eq('member_id', memberId)
    .eq('family_id', actor.family)
    .maybeSingle<MembershipRow>();
  if (error) throw error;
  return data;
}
export async function updateAccess(memberId: string, input: unknown) {
  if (
    !env.MEMBERSHIP_ACCESS_ENABLED &&
    (input as { enabled?: boolean }).enabled
  )
    throw new AppError('FORBIDDEN', 403, 'New access provisioning is disabled');
  const actor = mutationIdentity();
  // Restoring a claimed login requires the same provider subject and verified mailbox.
  if ((input as { enabled?: boolean }).enabled) {
    const existing = await readMemberAccess(memberId);
    if (existing?.app_user_id && existing.status === 'REVOKED') {
      const { data, error } = await getServiceRoleClient()
        .from('app_users')
        .select('auth_user_id')
        .eq('id', existing.app_user_id)
        .single();
      if (error || !data)
        throw new AppError(
          'IDENTITY_UNAVAILABLE',
          503,
          'Sign-in verification is temporarily unavailable',
        );
      const identity = await verifiedIdentity(data.auth_user_id);
      if (
        !identity.email ||
        identity.email.trim().toLowerCase() !== existing.login_email
      )
        throw new AppError(
          'EMAIL_CHANGE_REQUIRED',
          422,
          'Verify the reserved mailbox or complete the email replacement flow',
        );
    }
  }
  return accessRpc<MembershipRow | null>('set_member_access', {
    p_auth: actor.auth,
    p_family: actor.family,
    p_member: memberId,
    p_input: input,
    p_correlation: actor.correlation,
  });
}
export async function startEmailChange(
  memberId: string,
  email: string,
  version: number,
) {
  if (
    !env.ACCESS_EMAIL_DELIVERY_URL ||
    !env.ACCESS_EMAIL_DELIVERY_TOKEN ||
    !env.PUBLIC_APP_URL
  )
    throw new AppError(
      'EMAIL_DELIVERY_UNAVAILABLE',
      503,
      'Email delivery is not configured',
    );
  const actor = mutationIdentity();
  const token = randomBytes(32).toString('hex');
  const expiresAt = await accessRpc<string>('begin_membership_email_change', {
    p_auth: actor.auth,
    p_family: actor.family,
    p_member: memberId,
    p_email: email,
    p_version: version,
    p_hash: hashToken(token),
    p_correlation: actor.correlation,
  });
  // A failed delivery leaves access revoked; retry rotates the challenge with the returned version from GET access.
  try {
    const response = await fetch(env.ACCESS_EMAIL_DELIVERY_URL, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.ACCESS_EMAIL_DELIVERY_TOKEN}`,
      },
      body: JSON.stringify({
        to: email,
        template: 'membership-email-change',
        confirmationUrl: `${env.PUBLIC_APP_URL}/access-email-confirm?token=${token}`,
        expiresAt,
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error('delivery failed');
  } catch {
    throw new AppError(
      'EMAIL_DELIVERY_UNAVAILABLE',
      503,
      'Email could not be delivered. Access remains revoked; reload access and retry.',
    );
  }
  return { status: 'PENDING_VERIFICATION' as const, expiresAt };
}
export const hashToken = (token: string) =>
  createHash('sha256').update(token).digest('hex');
export async function confirmEmailChange(
  auth: string,
  token: string,
  correlation: string,
) {
  const identity = await verifiedIdentity(auth);
  if (!identity.email)
    throw new AppError(
      'INVALID_EMAIL_CHANGE',
      422,
      'A verified email is required',
    );
  await accessRpc('confirm_membership_email_change', {
    p_auth: auth,
    p_email: identity.email,
    p_hash: hashToken(token),
    p_correlation: correlation,
  });
}
