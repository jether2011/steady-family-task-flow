import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import Stripe from 'stripe';
vi.hoisted(() =>
  Object.assign(process.env, {
    SUPABASE_URL: 'https://project.supabase.co',
    SUPABASE_PUBLISHABLE_KEY: 'test',
    SUPABASE_SECRET_KEY: 'test',
    CORS_ORIGIN: 'http://localhost',
    STRIPE_MODE: 'TEST',
    STRIPE_SECRET_KEY: 'sk_test_fixture',
    STRIPE_WEBHOOK_SECRET: 'whsec_fixture',
    STRIPE_ACCOUNT_ID: 'acct_fixture',
  }),
);
const h = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../../src/config/supabase.js', () => ({
  getServiceRoleClient: () => ({ rpc: h.rpc }),
}));
import { billingWebhook } from '../../src/modules/billing/billing.webhook.js';
import { STRIPE_API_VERSION } from '../../src/modules/billing/billing.provider.js';
import { registerErrorHandler } from '../../src/middleware/error-handler.js';
let app: ReturnType<typeof Fastify>;
const stripe = new Stripe('sk_test_fixture');
function event(extra: Record<string, unknown> = {}) {
  return JSON.stringify(
    {
      id: 'evt_fixture',
      object: 'event',
      api_version: STRIPE_API_VERSION,
      type: 'invoice.paid',
      livemode: false,
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: 'in_fixture',
          customer: 'cus_fixture',
          card: { number: 'never-store' },
          customer_email: 'private@example.test',
        },
      },
      ...extra,
    },
    null,
    2,
  );
}
function send(
  body = event(),
  signedBody = body,
  timestamp = Math.floor(Date.now() / 1000),
) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/billing/webhooks/stripe',
    headers: {
      'content-type': 'application/json',
      'stripe-signature': stripe.webhooks.generateTestHeaderString({
        payload: signedBody,
        secret: 'whsec_fixture',
        timestamp,
      }),
    },
    payload: body,
  });
}
beforeEach(async () => {
  h.rpc.mockReset();
  h.rpc.mockResolvedValue({ data: null, error: null });
  app = Fastify();
  registerErrorHandler(app);
  await app.register(billingWebhook);
});
afterEach(() => app.close());
describe('signed durable Stripe ingress', () => {
  it('accepts exact signed raw bytes without Supabase authentication and stores minimized references only', async () => {
    const res = await send();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true });
    expect(h.rpc).toHaveBeenCalledWith(
      'billing_ingest',
      expect.objectContaining({
        p_event: 'evt_fixture',
        p_object: 'in_fixture',
        p_customer: 'cus_fixture',
        p_mode: 'TEST',
        p_merchant: 'acct_fixture',
        p_supported: true,
      }),
    );
    expect(JSON.stringify(h.rpc.mock.calls)).not.toMatch(
      /never-store|private@example|whsec|stripe-signature/,
    );
  });
  it('acknowledges duplicate ingress only through the durable dedupe operation', async () => {
    await send();
    await send();
    expect(h.rpc).toHaveBeenCalledTimes(2);
    expect(h.rpc.mock.calls[0][1].p_event).toBe(h.rpc.mock.calls[1][1].p_event);
  });
  it('ignores a valid unsupported event', async () => {
    expect((await send(event({ type: 'product.updated' }))).statusCode).toBe(
      200,
    );
    expect(h.rpc.mock.calls[0][1].p_supported).toBe(false);
  });
  it.each([
    { livemode: true },
    { account: 'acct_foreign' },
    { api_version: '2024-06-20' },
  ])('rejects incompatible mode/account/version %j', async (extra) => {
    expect((await send(event(extra))).statusCode).toBe(400);
    expect(h.rpc).not.toHaveBeenCalled();
  });
  it('rejects modified or expired signatures', async () => {
    expect((await send(event() + ' ', event())).statusCode).toBe(400);
    expect(
      (await send(event(), event(), Math.floor(Date.now() / 1000) - 301))
        .statusCode,
    ).toBe(400);
    expect(h.rpc).not.toHaveBeenCalled();
  });
  it('returns 503 instead of acknowledging a failed durable commit', async () => {
    h.rpc.mockResolvedValue({
      data: null,
      error: { message: 'database unavailable' },
    });
    const res = await send();
    expect(res.statusCode).toBe(503);
    expect(res.body).not.toContain('database unavailable');
  });
  it('bounds signature and raw body sizes', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/webhooks/stripe',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': 'a'.repeat(4097),
      },
      payload: '{}',
    });
    expect(res.statusCode).toBe(400);
    expect((await send(' '.repeat(262145))).statusCode).toBe(413);
  });
  it('does not change sibling JSON parsing', async () => {
    app.post('/ordinary', async (req) => req.body);
    const res = await app.inject({
      method: 'POST',
      url: '/ordinary',
      payload: { ok: true },
    });
    expect(res.json()).toEqual({ ok: true });
  });
  it('rejects malformed signed envelopes and future timestamps before persistence', async () => {
    expect((await send('{}')).statusCode).toBe(400);
    expect(
      (await send(event(), event(), Math.floor(Date.now() / 1000) + 301))
        .statusCode,
    ).toBe(400);
    expect(h.rpc).not.toHaveBeenCalled();
  });
});
