import { randomUUID } from 'node:crypto';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import {
  validatorCompiler,
  serializerCompiler,
} from 'fastify-type-provider-zod';
const h = vi.hoisted(() => ({
  rpc: vi.fn(),
  run: vi.fn(),
  role: 'OWNER',
  portal: vi.fn(),
  config: vi.fn(),
}));
vi.mock('../../src/config/env.js', () => ({
  env: {
    BILLING_AVAILABLE: true,
    CHECKOUT_ENABLED: true,
    STRIPE_MODE: 'TEST',
    STRIPE_ACCOUNT_ID: 'acct_fixture',
    STRIPE_PRICE_ID: 'price_fixture',
    STRIPE_PORTAL_CONFIGURATION_ID: 'bpc_fixture',
    PUBLIC_APP_URL: 'https://app.example.test',
    BILLING_AUTOMATIC_TAX: 'false',
  },
}));
const plan = {
  planKey: 'family-monthly',
  title: 'Approved fixture',
  currency: 'usd',
  unitAmount: 1234,
  interval: 'month',
  features: ['Fixture only'],
  memberLimit: null,
  termsUrl: 'https://app.example.test/terms',
  privacyUrl: 'https://app.example.test/privacy',
  policyUrl: 'https://app.example.test/policy',
  taxDisclosure: 'Fixture tax',
  available: true,
};
vi.mock('../../src/modules/billing/billing.provider.js', async (orig) => ({
  ...(await orig()),
  approvedPlan: async () => plan,
  verifyMerchant: async () => ({ id: 'acct_fixture' }),
  stripeClient: () => ({
    billingPortal: {
      configurations: { retrieve: h.config },
      sessions: { create: h.portal },
    },
  }),
}));
vi.mock('../../src/modules/billing/billing.worker.js', () => ({
  runAccount: h.run,
}));
vi.mock('../../src/modules/access/access.service.js', () => ({
  resolveMembership: async () => ({
    state: 'READY',
    user: { id: 'app' },
    membership: { family_id: 'family', role: h.role },
  }),
}));
vi.mock('../../src/config/supabase.js', () => ({
  getServiceRoleClient: () => ({
    rpc: h.rpc,
    from: () => ({
      select: () => ({
        eq: () => ({
          single: async () => ({
            data: { responsible_user_id: 'owner' },
            error: null,
          }),
        }),
      }),
      insert: async () => ({ error: null }),
    }),
  }),
}));
import { billingRoutes } from '../../src/modules/billing/billing.routes.js';
import { registerContext } from '../../src/middleware/context.js';
import { registerErrorHandler } from '../../src/middleware/error-handler.js';
import { Unauthorized } from '../../src/shared/errors/index.js';
let app: ReturnType<typeof Fastify>;
const attemptId = '00000000-0000-4000-8000-000000000001';
const attempt = {
  id: attemptId,
  account_id: 'account',
  state: 'OPEN',
  url: 'https://checkout.stripe.com/c/pay/fixture',
  expires_at: '2026-11-01T00:00:00Z',
};
const state = {
  account: {
    id: 'account',
    customer_id: 'cus_fixture',
    merchant: 'acct_fixture',
    verified_at: null,
  },
  attempt,
  subscriptions: [],
  activation: false,
};
beforeEach(async () => {
  vi.clearAllMocks();
  h.role = 'OWNER';
  h.rpc.mockResolvedValue({ data: state, error: null });
  h.run.mockResolvedValue(false);
  h.portal.mockResolvedValue({
    url: 'https://billing.stripe.com/p/session/fixture',
  });
  h.config.mockResolvedValue({
    id: 'bpc_fixture',
    active: true,
    livemode: false,
    features: {
      subscription_update: { enabled: false },
      subscription_cancel: { enabled: true, mode: 'at_period_end' },
    },
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
      billingRoutes(api);
    },
    { prefix: '/api/v1' },
  );
});
afterEach(() => app.close());
const headers = () => ({
  authorization: 'Bearer test',
  'idempotency-key': randomUUID(),
});
describe('owner billing HTTP boundaries', () => {
  it.each(['MANAGER', 'MEMBER'])(
    'keeps %s out of every private billing endpoint but permits authenticated plan display',
    async (role) => {
      h.role = role;
      for (const [method, path, payload] of [
        ['GET', '/billing/subscription', undefined],
        ['GET', '/billing/checkout/' + attemptId, undefined],
        ['POST', '/billing/checkout', { planKey: 'family-monthly' }],
        ['POST', '/billing/portal', {}],
      ] as const)
        expect(
          (
            await app.inject({
              method,
              url: '/api/v1' + path,
              headers: headers(),
              ...(payload ? { payload } : {}),
            })
          ).statusCode,
        ).toBe(403);
      expect(h.rpc).not.toHaveBeenCalled();
      expect(
        (await app.inject({ url: '/api/v1/billing/plan', headers: headers() }))
          .statusCode,
      ).toBe(200);
    },
  );
  it('does not expose provider/customer identities through the owner DTO', async () => {
    const res = await app.inject({
      url: '/api/v1/billing/subscription',
      headers: headers(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toMatch(/cus_fixture|acct_fixture/);
    expect(res.json().accessState).toBe('PENDING');
  });
  it.each([
    { planKey: 'family-monthly', price: 'price_forged' },
    { planKey: 'family-monthly', amount: 1 },
    { planKey: 'family-monthly', familyId: 'other' },
    { planKey: 'other' },
  ])('rejects forged commercial inputs %j', async (payload) => {
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/billing/checkout',
          headers: headers(),
          payload,
        })
      ).statusCode,
    ).toBe(422);
    expect(h.rpc).not.toHaveBeenCalled();
  });
  it('reserves with derived owner/family and returns the existing hosted session', async () => {
    h.rpc.mockResolvedValue({ data: { attempt, created: false }, error: null });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/checkout',
      headers: headers(),
      payload: { planKey: 'family-monthly' },
    });
    expect(res.statusCode).toBe(200);
    expect(h.rpc).toHaveBeenCalledWith(
      'billing_reserve',
      expect.objectContaining({
        p_auth: 'auth',
        p_family: 'family',
        p_mode: 'TEST',
        p_merchant: 'acct_fixture',
      }),
    );
  });
  it('returns PROCESSING for uncertain operations and never fabricates a URL', async () => {
    h.rpc
      .mockResolvedValueOnce({
        data: { attempt: { ...attempt, state: 'UNKNOWN' }, created: false },
        error: null,
      })
      .mockResolvedValue({
        data: { ...state, attempt: { ...attempt, state: 'UNKNOWN' } },
        error: null,
      });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/checkout',
      headers: headers(),
      payload: { planKey: 'family-monthly' },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ attemptId, state: 'PROCESSING' });
  });
  it('returns 404 for foreign attempts and rejects unsigned access', async () => {
    h.rpc.mockResolvedValue({ data: null, error: { message: 'NOT_FOUND' } });
    expect(
      (
        await app.inject({
          url: '/api/v1/billing/checkout/' + attemptId,
          headers: headers(),
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ url: '/api/v1/billing/subscription' })).statusCode,
    ).toBe(401);
  });
  it('rejects return URL hints and reports only server activation', async () => {
    const res = await app.inject({
      url: '/api/v1/billing/checkout/' + attemptId + '?paid=true',
      headers: headers(),
    });
    expect(res.statusCode).toBe(422);
    const valid = await app.inject({
      url: '/api/v1/billing/checkout/' + attemptId,
      headers: headers(),
    });
    expect(valid.json().activation).toBe('PENDING');
  });
  it('uses the stored customer and approved portal return; rejects client customer IDs', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/portal',
      headers: headers(),
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(h.portal).toHaveBeenCalledWith({
      customer: 'cus_fixture',
      configuration: 'bpc_fixture',
      return_url: 'https://app.example.test/billing',
    });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/billing/portal',
          headers: headers(),
          payload: { customer: 'cus_forged' },
        })
      ).statusCode,
    ).toBe(422);
  });
  it('sanitizes provider/storage failures and provider URL injection', async () => {
    h.portal.mockRejectedValue(new Error('card_secret_never_expose'));
    let res = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/portal',
      headers: headers(),
      payload: {},
    });
    expect(res.statusCode).toBe(503);
    expect(res.body).not.toContain('card_secret');
    h.portal.mockResolvedValue({ url: 'https://evil.example.test' });
    res = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/portal',
      headers: headers(),
      payload: {},
    });
    expect(res.statusCode).toBe(503);
  });
});
