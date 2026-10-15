import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
vi.hoisted(() =>
  Object.assign(process.env, {
    SUPABASE_URL: 'https://project.supabase.co',
    SUPABASE_PUBLISHABLE_KEY: 'test',
    SUPABASE_SECRET_KEY: 'test',
    CORS_ORIGIN: 'http://localhost',
  }),
);
const h = vi.hoisted(() => ({
  role: 'OWNER',
  state: 'READY',
  entitlement: {
    state: 'READ_ONLY',
    reason: 'EXPIRED',
    effectiveUntil: null,
    version: 290,
    canRead: true,
    canWrite: false,
    canManageBilling: true,
    ownerDeadlines: { paidThrough: 'owner-only' },
  },
  resolve: vi.fn(),
  rpc: vi.fn(),
}));
vi.mock('../../src/modules/access/access.service.js', async (orig) => ({
  ...(await orig()),
  resolveMembership: async () => ({
    state: h.state,
    user: { id: 'app', display_name: 'Person', avatar_url: null },
    membership:
      h.state === 'REVOKED'
        ? null
        : {
            id: '00000000-0000-4000-8000-000000000002',
            family_id: '00000000-0000-4000-8000-000000000003',
            role: h.role,
            member_id: '00000000-0000-4000-8000-000000000001',
            access_version: 2,
          },
  }),
}));
vi.mock('../../src/modules/entitlements/entitlements.service.js', () => ({
  resolveEntitlement: h.resolve,
}));
vi.mock('../../src/config/supabase.js', () => ({
  getServiceRoleClient: () => ({
    rpc: h.rpc,
    from: () => ({
      select: () => ({
        eq: () => ({
          single: async () => ({
            data: {
              responsible_user_id: 'owner',
              profile_completed_at: '2026-10-01',
            },
            error: null,
          }),
        }),
      }),
    }),
  }),
}));
vi.mock('../../src/modules/family/family.repository.js', () => ({
  loadFamilyAndResponsible: async () => ({
    family: {
      id: '00000000-0000-4000-8000-000000000003',
      name: 'Family',
      avatar_url: null,
    },
    responsible: { name: 'Owner', relationship: 'OTHER' },
  }),
}));
import { registerContext } from '../../src/middleware/context.js';
import { registerRequestScope } from '../../src/modules/access/access.store.js';
import { registerErrorHandler } from '../../src/middleware/error-handler.js';
import { accessRoutes } from '../../src/modules/access/access.routes.js';
import { bootstrapMe } from '../../src/modules/auth/auth.service.js';
import { AppError } from '../../src/shared/errors/index.js';
let app: ReturnType<typeof Fastify>;
const id = '00000000-0000-4000-8000-000000000001';
beforeEach(async () => {
  vi.clearAllMocks();
  h.role = 'OWNER';
  h.state = 'READY';
  h.entitlement = {
    state: 'READ_ONLY',
    reason: 'EXPIRED',
    effectiveUntil: null,
    version: 290,
    canRead: true,
    canWrite: false,
    canManageBilling: true,
    ownerDeadlines: { paidThrough: 'owner-only' },
  };
  h.resolve.mockImplementation(async () => h.entitlement);
  h.rpc.mockResolvedValue({
    data: {
      id: '00000000-0000-4000-8000-000000000004',
      family_id: '00000000-0000-4000-8000-000000000003',
      role: 'MEMBER',
      status: 'REVOKED',
      login_email: 'person@example.test',
      access_version: 3,
    },
    error: null,
  });
  app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandler(app);
  await app.register(
    async (api) => {
      registerRequestScope(api);
      api.addHook('preHandler', async (req) => {
        req.authUserId = 'auth';
      });
      registerContext(api);
      accessRoutes(api);
      for (const path of [
        '/family/tasks',
        '/family/board',
        '/family/leaderboard',
        '/family/awards',
        '/family/task-templates',
        '/family/members',
        '/family/points',
      ]) {
        api.get(path, async () => ({ view: true }));
        api.post(path, async () => ({ written: true }));
        api.patch(path, async () => ({ written: true }));
        api.delete(path, async () => ({ written: true }));
      }
    },
    { prefix: '/api/v1' },
  );
});
afterEach(() => app.close());
describe('role and entitlement HTTP intersection', () => {
  it.each(['OWNER', 'MANAGER'])(
    'keeps %s reads and security revocation, but no product writes, while READ_ONLY',
    async (role) => {
      h.role = role;
      for (const path of [
        '/family/tasks',
        '/family/board',
        '/family/leaderboard',
        '/family/awards',
        '/family/task-templates',
        '/family/members',
        '/family/points',
      ]) {
        expect((await app.inject({ url: '/api/v1' + path })).statusCode).toBe(
          200,
        );
        for (const method of ['POST', 'PATCH', 'DELETE'] as const) {
          const res = await app.inject({ method, url: '/api/v1' + path });
          expect(res.statusCode).toBe(403);
          expect(res.json().error.code).toBe('SUBSCRIPTION_REQUIRED');
        }
      }
      const revoke = await app.inject({
        method: 'POST',
        url: `/api/v1/family/members/${id}/access/revoke`,
        payload: { expectedVersion: 2 },
      });
      expect(revoke.statusCode).toBe(200);
      expect(h.rpc).toHaveBeenCalledWith(
        'security_revoke_access',
        expect.objectContaining({ p_auth: 'auth', p_member: id, p_version: 2 }),
      );
    },
  );
  it('never grants MEMBER management or security controls even with paid access', async () => {
    h.role = 'MEMBER';
    h.entitlement = { ...h.entitlement, state: 'ACTIVE', canWrite: true };
    expect((await app.inject({ url: '/api/v1/family/board' })).statusCode).toBe(
      200,
    );
    expect(
      (await app.inject({ url: '/api/v1/family/members' })).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/v1/family/members/${id}/access/revoke`,
          payload: { expectedVersion: 2 },
        })
      ).statusCode,
    ).toBe(403);
    expect(h.rpc).not.toHaveBeenCalled();
  });
  it('strictly forbids grant/profile fields in security-only revocation', async () => {
    for (const payload of [
      { expectedVersion: 2, enabled: true },
      { expectedVersion: 2, role: 'MANAGER' },
      { expectedVersion: 2, email: 'forged@example.test' },
    ])
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/api/v1/family/members/${id}/access/revoke`,
            payload,
          })
        ).statusCode,
      ).toBe(422);
    expect(h.rpc).not.toHaveBeenCalled();
  });
  it('prioritizes revoked membership over paid state', async () => {
    h.state = 'REVOKED';
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/family/tasks',
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('ACCESS_REVOKED');
    expect(h.resolve).not.toHaveBeenCalled();
  });
  it('keeps established read-only /me READY with limited capabilities and sanitized metadata', async () => {
    for (const role of ['OWNER', 'MANAGER', 'MEMBER']) {
      h.role = role;
      const me = await bootstrapMe('auth', {});
      expect(me.state).toBe('READY');
      expect(me.access).toMatchObject({
        state: 'READ_ONLY',
        version: 290,
        canManageBilling: role === 'OWNER',
      });
      expect(me.capabilities).not.toContain('family:manage');
      expect(me.capabilities).not.toContain('tasks:manage');
      expect(JSON.stringify(me)).not.toContain('owner-only');
      if (role !== 'MEMBER')
        expect(me.capabilities).toContain('members:security-revoke');
      else expect(me.capabilities).not.toContain('members:security-revoke');
    }
  });
  it('does not turn unavailable entitlement into an OAuth login or permit a write', async () => {
    h.resolve.mockRejectedValue(
      new AppError(
        'ENTITLEMENT_UNAVAILABLE',
        503,
        'Retry or use billing recovery',
      ),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/family/tasks',
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('ENTITLEMENT_UNAVAILABLE');
  });
});
