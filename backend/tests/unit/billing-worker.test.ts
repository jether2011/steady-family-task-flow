import { beforeEach, describe, it, expect, vi } from 'vitest';
const h = vi.hoisted(() => ({
  rpc: vi.fn(),
  attempts: [] as any[],
  customer: vi.fn(),
  search: vi.fn(),
  retrieveCustomer: vi.fn(),
  createSession: vi.fn(),
  retrieveSession: vi.fn(),
  listSessions: vi.fn(),
  subs: vi.fn(),
  invoices: vi.fn(),
  payments: vi.fn(),
  intent: vi.fn(),
  lines: vi.fn(),
}));
vi.mock('../../src/config/env.js', () => ({
  env: {
    STRIPE_MODE: 'TEST',
    STRIPE_ACCOUNT_ID: 'acct_fixture',
    BILLING_MAX_RETRIES: 3,
  },
}));
vi.mock('../../src/modules/access/access.repository.js', () => ({
  accessRpc: h.rpc,
}));
vi.mock('../../src/config/supabase.js', () => ({
  getServiceRoleClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({ order: async () => ({ data: h.attempts, error: null }) }),
      }),
    }),
  }),
}));
vi.mock('../../src/modules/billing/billing.provider.js', async (orig) => ({
  ...(await orig()),
  verifyMerchant: async () => ({ id: 'acct_fixture' }),
  stripeClient: () => ({
    customers: {
      create: h.customer,
      search: h.search,
      retrieve: h.retrieveCustomer,
    },
    checkout: {
      sessions: {
        create: h.createSession,
        retrieve: h.retrieveSession,
        list: h.listSessions,
      },
    },
    subscriptions: { list: h.subs },
    invoices: {
      list: h.invoices,
      retrieve: async () => ({ id: 'in_fixture', status: 'paid' }),
      listLineItems: h.lines,
    },
    invoicePayments: { list: h.payments },
    paymentIntents: { retrieve: h.intent },
  }),
}));
import {
  runAccount,
  paidEvidence,
} from '../../src/modules/billing/billing.worker.js';
const account = {
  id: 'account',
  family_id: 'family',
  mode: 'TEST',
  merchant: 'acct_fixture',
  customer_id: null,
  created_at: new Date().toISOString(),
  version: 1,
  lease_token: 'lease',
  quarantined: false,
};
const attempt = {
  id: 'attempt',
  account_id: 'account',
  family_id: 'family',
  state: 'CREATING',
  parameters: {
    price: 'price_fixture',
    origin: 'https://app.example.test',
    automaticTax: false,
  },
  session_id: null,
  subscription_id: null,
  created_at: new Date().toISOString(),
};
const session = {
  id: 'cs_fixture',
  livemode: false,
  mode: 'subscription',
  customer: 'cus_fixture',
  client_reference_id: 'attempt',
  metadata: {
    family: 'family',
    attempt: 'attempt',
    billing_account: 'account',
  },
  status: 'open',
  url: 'https://checkout.stripe.com/c/pay/fixture',
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  subscription: null,
};
const page = (data: unknown[]) => ({ autoPagingToArray: async () => data });
beforeEach(() => {
  vi.clearAllMocks();
  h.attempts = [structuredClone(attempt)];
  h.rpc.mockImplementation(async (name) =>
    name === 'billing_claim_account' ? structuredClone(account) : null,
  );
  h.customer.mockResolvedValue({ id: 'cus_fixture' });
  h.retrieveCustomer.mockResolvedValue({
    id: 'cus_fixture',
    livemode: false,
    metadata: { family: 'family', billing_account: 'account' },
  });
  h.createSession.mockResolvedValue(session);
  h.retrieveSession.mockResolvedValue(session);
  h.subs.mockReturnValue(page([]));
  h.listSessions.mockReturnValue(page([session]));
  h.search.mockResolvedValue({
    has_more: false,
    data: [{ id: 'cus_fixture' }],
  });
  h.invoices.mockResolvedValue({ data: [] });
});
describe('durable provider operations', () => {
  it('uses stable customer/session keys and explicit card/tax/quantity settings', async () => {
    expect(await runAccount('account')).toBe(true);
    expect(h.customer).toHaveBeenCalledWith(
      { metadata: { billing_account: 'account', family: 'family' } },
      { idempotencyKey: 'customer:account' },
    );
    expect(h.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'subscription',
        customer: 'cus_fixture',
        allowed_payment_method_types: ['card'],
        line_items: [{ price: 'price_fixture', quantity: 1 }],
        automatic_tax: { enabled: false },
        success_url: 'https://app.example.test/billing/return?attempt=attempt',
        cancel_url: 'https://app.example.test/subscribe?checkout=canceled',
      }),
      { idempotencyKey: 'checkout:attempt' },
    );
    expect(h.rpc).toHaveBeenCalledWith(
      'billing_apply_snapshot',
      expect.objectContaining({ p_version: 1, p_subscriptions: [] }),
    );
  });
  it('leaves timeout creation UNKNOWN and retries with the identical key', async () => {
    h.createSession.mockRejectedValueOnce(new Error('provider secret error'));
    expect(await runAccount()).toBe(false);
    expect(h.rpc).toHaveBeenCalledWith(
      'billing_finish_operation',
      expect.objectContaining({ p_session: { state: 'UNKNOWN' } }),
    );
    expect(JSON.stringify(h.rpc.mock.calls)).not.toContain(
      'provider secret error',
    );
    expect(await runAccount()).toBe(true);
    expect(h.createSession.mock.calls[0]).toEqual(
      h.createSession.mock.calls[1],
    );
  });
  it('recovers beyond provider key retention through discovery, never a fresh create', async () => {
    h.rpc.mockImplementation(async (name) =>
      name === 'billing_claim_account'
        ? { ...account, created_at: '2020-01-01T00:00:00Z' }
        : null,
    );
    h.attempts[0].created_at = '2020-01-01T00:00:00Z';
    expect(await runAccount()).toBe(true);
    expect(h.search).toHaveBeenCalled();
    expect(h.listSessions).toHaveBeenCalled();
    expect(h.customer).not.toHaveBeenCalled();
    expect(h.createSession).not.toHaveBeenCalled();
  });
  it('quarantines ambiguous expired operation keys', async () => {
    h.rpc.mockImplementation(async (name) =>
      name === 'billing_claim_account'
        ? { ...account, created_at: '2020-01-01T00:00:00Z' }
        : null,
    );
    h.search.mockResolvedValue({ has_more: false, data: [] });
    expect(await runAccount()).toBe(false);
    expect(h.customer).not.toHaveBeenCalled();
    expect(h.rpc).toHaveBeenCalledWith(
      'billing_fail_account',
      expect.objectContaining({
        p_quarantine: true,
        p_error: 'CUSTOMER_OPERATION_AMBIGUOUS',
      }),
    );
  });
  it('rejects foreign customer/session metadata and unexpected subscriptions', async () => {
    h.retrieveSession.mockResolvedValue({
      ...session,
      customer: 'cus_foreign',
    });
    h.attempts[0].session_id = 'cs_fixture';
    expect(await runAccount()).toBe(false);
    expect(h.rpc).not.toHaveBeenCalledWith(
      'billing_apply_snapshot',
      expect.anything(),
    );
  });
  it('does not treat active status or a paid out-of-band invoice as settled evidence', async () => {
    const invoice = {
      status: 'paid',
      status_transitions: { paid_at: 123 },
      collection_method: 'charge_automatically',
      amount_due: 100,
      amount_paid: 100,
      amount_paid_off_stripe: 100,
    };
    expect(await paidEvidence(invoice as any, {} as any, 'cus_fixture')).toBe(
      null,
    );
    expect(h.payments).not.toHaveBeenCalled();
  });
  it('requires a successful captured card payment and matching recurring invoice line', async () => {
    const invoice = {
      id: 'in_fixture',
      status: 'paid',
      status_transitions: { paid_at: 123 },
      collection_method: 'charge_automatically',
      amount_due: 100,
      amount_paid: 100,
      amount_paid_off_stripe: 0,
      customer: 'cus_fixture',
      parent: { subscription_details: { subscription: 'sub_fixture' } },
      livemode: false,
      currency: 'usd',
    };
    h.payments.mockReturnValue(
      page([
        {
          payment: { type: 'payment_intent', payment_intent: 'pi_fixture' },
          amount_paid: 100,
        },
      ]),
    );
    h.intent.mockResolvedValue({
      status: 'succeeded',
      currency: 'usd',
      customer: 'cus_fixture',
      livemode: false,
      latest_charge: {
        paid: true,
        captured: true,
        refunded: false,
        disputed: false,
        amount_refunded: 0,
      },
    });
    h.lines.mockReturnValue(
      page([
        {
          subscription: 'sub_fixture',
          pricing: { price_details: { price: 'price_fixture' } },
          parent: { subscription_item_details: { proration: false } },
          quantity: 1,
          period: { end: 1800000000 },
        },
      ]),
    );
    expect(
      await paidEvidence(
        invoice as any,
        {
          id: 'sub_fixture',
          items: { data: [{ price: { id: 'price_fixture' } }] },
        } as any,
        'cus_fixture',
      ),
    ).toBe(new Date(1800000000000).toISOString());
    h.intent.mockResolvedValue({ latest_charge: { disputed: true } });
    await expect(
      paidEvidence(invoice as any, { id: 'sub_fixture' } as any, 'cus_fixture'),
    ).rejects.toThrow('PAYMENT_REVIEW_REQUIRED');
  });
  it('reads pinned-version item periods and scheduled cancellation without equating active to paid', async () => {
    h.attempts[0] = {
      ...h.attempts[0],
      state: 'COMPLETED',
      session_id: 'cs_fixture',
      subscription_id: 'sub_fixture',
    };
    h.retrieveSession.mockResolvedValue({
      ...session,
      status: 'complete',
      subscription: 'sub_fixture',
      url: null,
    });
    const sub = {
      id: 'sub_fixture',
      livemode: false,
      customer: 'cus_fixture',
      metadata: {
        family: 'family',
        billing_account: 'account',
        attempt: 'attempt',
      },
      items: {
        has_more: false,
        data: [
          {
            price: { id: 'price_fixture' },
            quantity: 1,
            current_period_start: 1790812800,
            current_period_end: 1793491200,
          },
        ],
      },
      collection_method: 'charge_automatically',
      status: 'active',
      cancel_at_period_end: false,
      cancel_at: 1793491200,
      trial_end: null,
      latest_invoice: 'in_fixture',
    };
    h.subs.mockReturnValue(page([sub]));
    expect(await runAccount()).toBe(true);
    expect(h.rpc).toHaveBeenCalledWith(
      'billing_apply_snapshot',
      expect.objectContaining({
        p_subscriptions: [
          expect.objectContaining({
            id: 'sub_fixture',
            status: 'active',
            cancelAtPeriodEnd: true,
            periodEnd: new Date(1793491200000).toISOString(),
            paidThrough: null,
          }),
        ],
      }),
    );
  });
});
