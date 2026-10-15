vi.mock('../../src/modules/entitlements/entitlements.service.js',()=>({resolveEntitlement:async()=>({state:'LEGACY',reason:'LEGACY',effectiveUntil:null,version:130,canRead:true,canWrite:true,canManageBilling:false,ownerDeadlines:null})}));
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import {
  validatorCompiler,
  serializerCompiler,
} from 'fastify-type-provider-zod';
vi.hoisted(() =>
  Object.assign(process.env, {
    SUPABASE_URL: 'https://project.supabase.co',
    SUPABASE_PUBLISHABLE_KEY: 'test',
    SUPABASE_SECRET_KEY: 'test',
    CORS_ORIGIN: 'http://localhost',
  }),
);
const state = vi.hoisted(() => ({ role: 'MEMBER', rpc: vi.fn() }));
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
vi.mock('../../src/modules/access/access.service.js', () => ({
  resolveMembership: async () => ({
    state: 'READY',
    user: { id: 'app' },
    membership: {
      id: 'membership',
      family_id: 'family',
      role: state.role,
      member_id: '00000000-0000-4000-8000-000000000001',
      access_version: 2,
    },
  }),
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
import { memberViewRoutes } from '../../src/modules/member-views/views.routes.js';
import { registerErrorHandler } from '../../src/middleware/error-handler.js';
let app: ReturnType<typeof Fastify>;
beforeEach(async () => {
  state.role = 'MEMBER';
  state.rpc.mockReset();
  state.rpc.mockImplementation(async (_name, args) => ({
    data:
      args.p_kind === 'points'
        ? { transactions: [] }
        : args.p_kind === 'completions'
          ? { completions: [], transactions: [] }
          : args.p_kind === 'directory'
            ? {
                members: [
                  {
                    id: id(1),
                    name: 'Self',
                    avatar_url: null,
                    color: null,
                    member_type: 'CHILD',
                    active: true,
                    birth_year: 2010,
                    login_email: 'private@example.test',
                    app_user_id: 'hidden',
                  },
                ],
              }
            : {
                earned: 0,
                adjustments: 0,
                reversed: 0,
                spent: 0,
                net: 0,
                balance: 0,
              },
    error: null,
  }));
  app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandler(app);
  await app.register(
    async (api) => {
      api.addHook('preHandler', async (req) => {
        req.authUserId = 'verified-subject';
      });
      registerContext(api);
      memberViewRoutes(api);
      api.get('/family/dashboard', async () => ({ private: true }));
    },
    { prefix: '/api/v1' },
  );
});
afterEach(() => app.close());
describe('member HTTP boundaries', () => {
  it.each(['/family/points', '/family/points/summary'])(
    'forces self for %s',
    async (path) => {
      const response = await app.inject({ url: '/api/v1' + path });
      expect(response.statusCode).toBe(200);
      expect(state.rpc).toHaveBeenCalledWith(
        'member_view_read',
        expect.objectContaining({
          p_auth: 'verified-subject',
          p_input: expect.objectContaining({ memberId: id(1) }),
        }),
      );
    },
  );
  it.each([
    '/family/points?memberId=',
    '/family/points/summary?memberId=',
    '/family/members/',
  ])('rejects another participant via %s', async (prefix) => {
    const url =
      prefix === '/family/members/'
        ? prefix + id(2) + '/profile'
        : prefix + id(2);
    expect((await app.inject({ url: '/api/v1' + url })).statusCode).toBe(404);
    expect(state.rpc).not.toHaveBeenCalled();
  });
  it('denies legacy full dashboard to member', async () => {
    expect(
      (await app.inject({ url: '/api/v1/family/dashboard' })).statusCode,
    ).toBe(403);
  });
  it.each([
    '/family/member-dashboard?memberId=x',
    '/family/points?limit=101',
    '/family/points?from=2025-02-30',
    '/family/points?from=2025-03-11&to=2025-03-10',
    '/family/points?cursor=forged',
  ])('rejects invalid or untrusted filters %s', async (path) => {
    expect((await app.inject({ url: '/api/v1' + path })).statusCode).toBe(422);
    expect(state.rpc).not.toHaveBeenCalled();
  });
  it('projects directory data and strips private columns before returning JSON', async () => {
    const response = await app.inject({
      url: '/api/v1/family/member-directory',
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toMatch(
      /birth_year|login_email|app_user_id|private@example/,
    );
  });
  it('permits a manager to select a participant filter', async () => {
    state.role = 'MANAGER';
    expect(
      (await app.inject({ url: '/api/v1/family/points?memberId=' + id(2) }))
        .statusCode,
    ).toBe(200);
    expect(state.rpc).toHaveBeenCalledWith(
      'member_view_read',
      expect.objectContaining({
        p_input: expect.objectContaining({ memberId: id(2) }),
      }),
    );
  });
});
