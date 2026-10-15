import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import type { Resolution } from '../../src/modules/access/access.types.js';
const state = vi.hoisted(() => ({
  resolution: null as Resolution | null,
  rpc: vi.fn(),
}));
vi.hoisted(() => {
  Object.assign(process.env, {
    SUPABASE_URL: 'https://project.supabase.co',
    SUPABASE_PUBLISHABLE_KEY: 'test',
    SUPABASE_SECRET_KEY: 'test',
    CORS_ORIGIN: 'http://localhost',
  });
});
vi.mock('../../src/modules/access/access.service.js', () => ({
  resolveMembership: vi.fn(async () => state.resolution),
}));
vi.mock('../../src/config/supabase.js', () => ({
  getServiceRoleClient: () => ({
    rpc: state.rpc,
    from: () => ({
      select: () => ({
        eq: () => ({
          single: async () => ({
            data: {
              responsible_user_id: 'owner',
              lifecycle: 'ESTABLISHED',
              creation_source: 'LEGACY',
              legacy_access_eligible: true,
              profile_completed_at: '2026-10-01T00:00:00Z',
            },
            error: null,
          }),
        }),
      }),
    }),
  }),
}));
import { registerContext } from '../../src/middleware/context.js';
import { registerRequestScope } from '../../src/modules/access/access.store.js';
import { resourceWrite } from '../../src/modules/access/access.repository.js';
import { registerErrorHandler } from '../../src/middleware/error-handler.js';
function resolution(role: 'OWNER' | 'MANAGER' | 'MEMBER'): Resolution {
  return {
    state: 'READY',
    user: {
      id: 'app',
      auth_user_id: 'auth',
      display_name: null,
      avatar_url: null,
    },
    membership: {
      id: 'membership',
      family_id: 'family',
      app_user_id: 'app',
      member_id: role === 'OWNER' ? null : 'member',
      role,
      status: 'ACTIVE',
      login_email: 'person@example.test',
      access_version: 2,
    },
  };
}
let app: ReturnType<typeof Fastify>;
beforeEach(async () => {
  state.resolution = resolution('MEMBER');
  state.rpc.mockReset();
  state.rpc.mockResolvedValue({ data: [], error: null });
  app = Fastify();
  registerErrorHandler(app);
  await app.register(
    async (api) => {
      registerRequestScope(api);
      api.addHook('preHandler', async (request) => {
        request.authUserId = 'auth';
      });
      registerContext(api);
      for (const url of [
        '/family/points',
        '/family/dashboard',
        '/family/members',
        '/family/tasks',
        '/family/members/:id/completions',
        '/family/task-templates',
      ])
        api.get(url, async (req) => ({
          query: req.query,
          role: req.ctx?.role,
        }));
      api.post('/family/tasks', async () => ({
        rows: await resourceWrite('tasks', 'insert', 'family', null, {
          title: 'safe',
        }),
      }));
    },
    { prefix: '/api/v1' },
  );
});
afterEach(() => app.close());
describe('role and request-scope authorization', () => {
  it.each(['/family/dashboard', '/family/members', '/family/task-templates'])(
    'denies private management read %s to member',
    async (path) => {
      expect((await app.inject({ url: '/api/v1' + path })).statusCode).toBe(
        403,
      );
    },
  );
  it('forces own ledger filter and denies another participant history', async () => {
    const own = await app.inject({ url: '/api/v1/family/points' });
    expect(own.statusCode).toBe(200);
    expect(own.json().query.memberId).toBe('member');
    expect(
      (await app.inject({ url: '/api/v1/family/points?memberId=other' }))
        .statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ url: '/api/v1/family/members/other/completions' }))
        .statusCode,
    ).toBe(404);
  });
  it('blocks member mutations before privileged execution', async () => {
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/family/tasks',
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
    expect(state.rpc).not.toHaveBeenCalled();
  });
  it.each(['OWNER', 'MANAGER'] as const)(
    'carries %s request identity into transaction-level authorization',
    async (role) => {
      state.resolution = resolution(role);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/family/tasks',
            payload: {},
          })
        ).statusCode,
      ).toBe(200);
      expect(state.rpc).toHaveBeenCalledWith(
        'authorized_resource_write',
        expect.objectContaining({ p_auth: 'auth', p_family: 'family' }),
      );
    },
  );
  it('rejects service mutation calls with no authenticated request scope', async () => {
    await expect(
      resourceWrite('tasks', 'insert', 'family', null, {}),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('denies a revoked context on next request', async () => {
    state.resolution = {
      ...resolution('MEMBER'),
      membership: null,
      state: 'REVOKED',
    };
    expect((await app.inject({ url: '/api/v1/family/tasks' })).statusCode).toBe(
      403,
    );
  });
});
