import type { FastifyInstance, FastifyRequest } from 'fastify';
import { getServiceRoleClient } from '../config/supabase.js';
import {
  NotFound,
  Unauthorized,
  AppError,
  Forbidden,
} from '../shared/errors/index.js';
import { resolveMembership } from '../modules/access/access.service.js';
import { resolveEntitlement } from '../modules/entitlements/entitlements.service.js';
import type { RequestContext } from './types.js';
import './types.js';
export async function resolveContext(
  authUserId: string,
): Promise<RequestContext> {
  const resolved = await resolveMembership(authUserId);
  const m = resolved.membership;
  let ownerId: string | null = null;
  if (m) {
    const { data, error } = await getServiceRoleClient()
      .from('families')
      .select('responsible_user_id')
      .eq('id', m.family_id)
      .single();
    if (error) throw error;
    ownerId = data.responsible_user_id;
  }
  return {
    userId: authUserId,
    authUserId,
    appUserId: resolved.user.id,
    responsibleUserId: ownerId,
    ownerResponsibleUserId: ownerId,
    familyId: m?.family_id ?? null,
    membershipId: m?.id ?? null,
    role: m?.role ?? null,
    memberId: m?.member_id ?? null,
    accessVersion: m?.access_version ?? null,
    accessState: resolved.state,
  };
}
export async function contextHook(request: FastifyRequest) {
  if (!request.authUserId) throw new Unauthorized();
  // /me resolves/claims once in its service; email confirmation is valid with revoked membership.
  if (
    request.routeOptions.url === '/api/v1/billing/plan' ||
    request.routeOptions.url === '/api/v1/families' ||
    request.routeOptions.url === '/api/v1/me' ||
    request.routeOptions.url === '/api/v1/me/email-change/confirm'
  )
    return;
  request.ctx = await resolveContext(request.authUserId);
  requireFamilyContext(request);
  const ctx = request.ctx;
  const url = request.routeOptions.url ?? '';
  if (url === '/api/v1/billing/plan') return;
  if (url.startsWith('/api/v1/billing/')) {
    if (ctx.role !== 'OWNER') throw new Forbidden();
    return;
  }
  if (url === '/api/v1/family/onboarding') {
    if (ctx.role !== 'OWNER') throw new Forbidden();
    return;
  }
  if (ctx.role === 'MEMBER') {
    const allowed = new Set([
      '/api/v1/family',
      '/api/v1/family/member-dashboard',
      '/api/v1/family/member-directory',
      '/api/v1/family/points/summary',
      '/api/v1/family/members/:id/profile',
      '/api/v1/family/tasks',
      '/api/v1/family/board',
      '/api/v1/family/leaderboard',
      '/api/v1/family/awards',
      '/api/v1/family/points',
      '/api/v1/family/members/:id/completions',
    ]);
    if (request.method !== 'GET' || !allowed.has(url)) throw new Forbidden();
    if (
      (url.endsWith('/completions') || url.endsWith('/profile')) &&
      (request.params as { id: string }).id !== ctx.memberId
    )
      throw new NotFound();
    if (url.endsWith('/points') || url.endsWith('/points/summary')) {
      const query = request.query as { memberId?: string };
      if (query.memberId && query.memberId !== ctx.memberId)
        throw new NotFound();
      query.memberId = ctx.memberId!;
    }
  }
  const securityRevoke =
    url === '/api/v1/family/members/:id/access/revoke' &&
    request.method === 'POST';
  if (securityRevoke && ['OWNER', 'MANAGER'].includes(ctx.role ?? '')) return;
  const entitlement = await resolveEntitlement(
    request.authUserId,
    ctx.familyId!,
  );
  if (!entitlement.canRead)
    throw new AppError(
      'SUBSCRIPTION_REQUIRED',
      403,
      'Family access requires subscription setup',
    );
  if (!['GET', 'HEAD'].includes(request.method) && !entitlement.canWrite)
    throw new AppError(
      'SUBSCRIPTION_REQUIRED',
      403,
      'Your family currently has view-only access',
    );
}
export function requireFamilyContext(request: FastifyRequest) {
  const ctx = request.ctx;
  if (!ctx) throw new Unauthorized();
  if (ctx.accessState === 'REVOKED')
    throw new AppError('ACCESS_REVOKED', 403, 'Family access has been revoked');
  if (!ctx.familyId || !ctx.responsibleUserId) throw new NotFound();
  return {
    ...ctx,
    familyId: ctx.familyId,
    responsibleUserId: ctx.responsibleUserId,
  };
}
export function registerContext(app: FastifyInstance) {
  app.addHook('preHandler', contextHook);
}
