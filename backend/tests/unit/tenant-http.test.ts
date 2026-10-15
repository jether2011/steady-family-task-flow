import { randomUUID } from 'node:crypto';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
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
const h = vi.hoisted(() => ({
  rpc: vi.fn(),
  identity: vi.fn(),
  role: 'OWNER',
  tenant: {
    lifecycle: 'DRAFT',
    creation_source: 'SELF_SERVICE',
    legacy_access_eligible: false,
    profile_completed_at: '2026-10-01',
  },
}));
vi.mock('../../src/modules/entitlements/entitlements.service.js',()=>({resolveEntitlement:async()=>{const ready=h.tenant.lifecycle==='ESTABLISHED' && h.tenant.creation_source==='LEGACY' && h.tenant.legacy_access_eligible;return{state:ready?'LEGACY':'DRAFT',reason:ready?'LEGACY':'PAYMENT_PENDING',effectiveUntil:null,version:100,canRead:ready,canWrite:ready,ownerDeadlines:null};}}));
vi.mock('../../src/modules/access/access.service.js', () => ({
  verifiedIdentity: h.identity,
  resolveMembership: async () => ({
    state: 'READY',
    user: { id: 'app' },
    membership: {
      id: 'membership',
      family_id: 'family',
      role: h.role,
      app_user_id: 'app',
      member_id: null,
      access_version: 1,
    },
  }),
}));
vi.mock('../../src/config/supabase.js', () => ({
  getServiceRoleClient: () => ({
    rpc: h.rpc,
    from: () => ({
      select: () => ({
        eq: () => ({
          single: async () => ({
            data: { responsible_user_id: 'owner', ...h.tenant },
            error: null,
          }),
        }),
      }),
    }),
  }),
}));
import { tenantRoutes } from '../../src/modules/tenant/tenant.routes.js';
import { registerContext } from '../../src/middleware/context.js';
import { registerErrorHandler } from '../../src/middleware/error-handler.js';
import { Unauthorized } from '../../src/shared/errors/index.js';
let app: ReturnType<typeof Fastify>;
const body = {
  name: 'New Family',
  responsible_name: 'Owner',
  relationship: 'OTHER',
};
const family = {
  id: '00000000-0000-4000-8000-000000000001',
  avatar_url: null,
  ...body,
};
const response = {
  family,
  lifecycle: 'DRAFT',
  profileCompleted: true,
  nextAction: 'SUBSCRIBE',
};
beforeEach(async () => {
  vi.clearAllMocks();
  h.role = 'OWNER';
  h.tenant = {
    lifecycle: 'DRAFT',
    creation_source: 'SELF_SERVICE',
    legacy_access_eligible: false,
    profile_completed_at: '2026-10-01',
  };
  h.identity.mockResolvedValue({ email: 'verified@example.test' });
  h.rpc.mockResolvedValue({
    data: { ...response, created: true },
    error: null,
  });
  app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandler(app);
  await app.register(
    async (api) => {
      api.addHook('preHandler', async (req) => {
        if (!req.headers.authorization) throw new Unauthorized();
        req.authUserId = 'auth';
      });
      registerContext(api);
      tenantRoutes(api);
      api.get('/family/tasks', async () => ({ tasks: ['must not mount'] }));
      api.patch('/family', async () => ({ ok: true }));
    },
    { prefix: '/api/v1' },
  );
});
afterEach(() => app.close());
const headers = () => ({
  authorization: 'Bearer test',
  'idempotency-key': randomUUID(),
});
describe('tenant HTTP contracts and lifecycle boundary', () => {
  it('creates with 201, server identity, normalized fields and no leaked internal created flag', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/families',
      headers: headers(),
      payload: { ...body, name: ' New Family ' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ ...response, billingAvailable: false });
    expect(h.rpc).toHaveBeenCalledWith(
      'create_tenant',
      expect.objectContaining({
        p_auth: 'auth',
        p_email: 'verified@example.test',
        p_enabled: false,
        p_input: body,
        p_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    );
  });
  it('rejects an unverified mailbox before any creation RPC', async () => {
    h.identity.mockResolvedValue({ email: null });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/families',
      headers: headers(),
      payload: body,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('EMAIL_VERIFICATION_REQUIRED');
    expect(h.rpc).not.toHaveBeenCalled();
  });
  it('returns 200 for replay/current state and maps conflicts safely', async () => {
    h.rpc.mockResolvedValueOnce({
      data: { ...response, created: false },
      error: null,
    });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/families',
          headers: headers(),
          payload: body,
        })
      ).statusCode,
    ).toBe(200);
    h.rpc.mockResolvedValue({
      data: null,
      error: { message: 'IDEMPOTENCY_CONFLICT' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/families',
      headers: headers(),
      payload: body,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('IDEMPOTENCY_CONFLICT');
  });
  it.each([
    { ...body, name: ' ' },
    { ...body, name: 'a'.repeat(121) },
    { ...body, relationship: 'OWNER' },
    { ...body, family_id: randomUUID() },
    { ...body, paid: true },
  ])('strictly rejects invalid/server-owned fields %j', async (payload) => {
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/families',
          headers: headers(),
          payload,
        })
      ).statusCode,
    ).toBe(422);
    expect(h.rpc).not.toHaveBeenCalled();
  });
  it('requires a UUID key and authenticated subject', async () => {
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/families',
          headers: { authorization: 'test' },
          payload: body,
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/families',
          headers: { 'idempotency-key': randomUUID() },
          payload: body,
        })
      ).statusCode,
    ).toBe(401);
  });
  it.each(['MEMBER', 'MANAGER'])(
    'forbids %s from owner onboarding',
    async (role) => {
      h.role = role;
      expect(
        (
          await app.inject({
            url: '/api/v1/family/onboarding',
            headers: headers(),
          })
        ).statusCode,
      ).toBe(403);
      expect(h.rpc).not.toHaveBeenCalled();
    },
  );
  it('allows owner draft GET/PATCH but rejects blank and server-owned patches', async () => {
    expect(
      (
        await app.inject({
          url: '/api/v1/family/onboarding',
          headers: headers(),
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: '/api/v1/family/onboarding',
          headers: headers(),
          payload: { name: 'Renamed' },
        })
      ).statusCode,
    ).toBe(200);
    expect(h.rpc).toHaveBeenCalledWith('tenant_onboarding', {
      p_auth: 'auth',
      p_input: { name: 'Renamed' },
    });
    for (const payload of [
      { name: ' ' },
      { responsible_name: '' },
      { creation_source: 'LEGACY' },
    ])
      expect(
        (
          await app.inject({
            method: 'PATCH',
            url: '/api/v1/family/onboarding',
            headers: headers(),
            payload,
          })
        ).statusCode,
      ).toBe(422);
  });
  it.each(['OWNER', 'MANAGER', 'MEMBER'])(
    'blocks draft product and generic settings endpoints for %s',
    async (role) => {
      h.role = role;
      for (const [method, url] of [
        ['GET', '/family/tasks'],
        ['PATCH', '/family'],
      ] as const) {
        const res = await app.inject({
          method,
          url: '/api/v1' + url,
          headers: headers(),
        });
        expect(res.statusCode).toBe(403);
        expect(res.json().error.code).toBe(role==='MEMBER' && method!=='GET'?'FORBIDDEN':'SUBSCRIPTION_REQUIRED');
      }
    },
  );
  it('does not treat SELF_SERVICE establishment alone as entitlement', async () => {
    h.tenant.lifecycle = 'ESTABLISHED';
    expect(
      (await app.inject({ url: '/api/v1/family/tasks', headers: headers() }))
        .statusCode,
    ).toBe(403);
  });
  it('keeps established eligible legacy households working', async () => {
    h.tenant = {
      ...h.tenant,
      lifecycle: 'ESTABLISHED',
      creation_source: 'LEGACY',
      legacy_access_eligible: true,
    };
    expect(
      (await app.inject({ url: '/api/v1/family/tasks', headers: headers() }))
        .statusCode,
    ).toBe(200);
  });
});
