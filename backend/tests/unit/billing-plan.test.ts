import { beforeEach, describe, it, expect, vi } from 'vitest';
const h = vi.hoisted(() => ({
  price: vi.fn(),
  portal: vi.fn(),
  account: vi.fn(),
  env: {
    STRIPE_SECRET_KEY: 'sk_test_fixture',
    STRIPE_MODE: 'TEST',
    STRIPE_ACCOUNT_ID: 'acct_fixture',
    STRIPE_MERCHANT_COUNTRY: 'US',
    STRIPE_PRICE_ID: 'price_fixture',
    STRIPE_PORTAL_CONFIGURATION_ID: 'bpc_fixture',
    PUBLIC_APP_URL: 'https://app.example.test',
    BILLING_PLAN_TITLE: 'Approved fixture',
    BILLING_PLAN_FEATURES: 'Board|History',
    BILLING_MEMBER_LIMIT: 'unlimited',
    BILLING_CURRENCY: 'usd',
    BILLING_TAX_BEHAVIOR: 'exclusive',
    BILLING_AUTOMATIC_TAX: 'false',
    BILLING_PAYMENT_METHODS: 'card',
    BILLING_TERMS_URL: 'https://app.example.test/terms',
    BILLING_PRIVACY_URL: 'https://app.example.test/privacy',
    BILLING_POLICY_URL: 'https://app.example.test/policy',
    BILLING_TAX_DISCLOSURE: 'Fixture tax',
    BILLING_APPROVAL_REFERENCE: 'APPROVED-FIXTURE',
    BILLING_AVAILABLE: true,
    CHECKOUT_ENABLED: true,
  },
}));
vi.mock('../../src/config/env.js', () => ({ env: h.env }));
vi.mock('stripe', () => ({
  default: class {
    accounts = { retrieve: h.account };
    prices = { retrieve: h.price };
    billingPortal = { configurations: { retrieve: h.portal } };
  },
}));
import { approvedPlan } from '../../src/modules/billing/billing.provider.js';
const price = {
  id: 'price_fixture',
  active: true,
  livemode: false,
  type: 'recurring',
  recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' },
  billing_scheme: 'per_unit',
  unit_amount: 1234,
  currency: 'usd',
  tax_behavior: 'exclusive',
  product: { id: 'prod_fixture', active: true },
};
const portal = {
  active: true,
  livemode: false,
  features: {
    subscription_cancel: { enabled: true, mode: 'at_period_end' },
    subscription_update: { enabled: false },
    payment_method_update: { enabled: true },
    invoice_history: { enabled: true },
  },
  business_profile: {
    terms_of_service_url: 'https://app.example.test/terms',
    privacy_policy_url: 'https://app.example.test/privacy',
  },
};
beforeEach(() => {
  vi.clearAllMocks();
  h.account.mockResolvedValue({ id: 'acct_fixture', country: 'US' });
  h.price.mockResolvedValue(structuredClone(price));
  h.portal.mockResolvedValue(structuredClone(portal));
  h.env.CHECKOUT_ENABLED = true;
});
describe('approved commercial configuration abstraction', () => {
  it('reads the amount from the approved provider price and normalizes explicit unlimited/features', async () => {
    expect(await approvedPlan()).toMatchObject({
      unitAmount: 1234,
      currency: 'usd',
      memberLimit: null,
      features: ['Board', 'History'],
      available: true,
    });
    expect(h.price).toHaveBeenCalledWith('price_fixture', {
      expand: ['product'],
    });
  });
  it.each([
    { unit_amount: null },
    { active: false },
    { livemode: true },
    { currency: 'eur' },
    { tax_behavior: 'inclusive' },
    {
      recurring: {
        interval: 'year',
        interval_count: 1,
        usage_type: 'licensed',
      },
    },
    { product: { id: 'prod_fixture', active: false } },
    { id: 'price_foreign' },
  ])('rejects incompatible provider price/product %j', async (patch) => {
    h.price.mockResolvedValue({ ...price, ...patch });
    await expect(approvedPlan()).rejects.toMatchObject({
      code: 'BILLING_UNAVAILABLE',
    });
  });
  it('checks the merchant account and country before quoting', async () => {
    h.account.mockResolvedValue({ id: 'acct_foreign', country: 'US' });
    await expect(approvedPlan()).rejects.toMatchObject({
      code: 'BILLING_UNAVAILABLE',
    });
    expect(h.price).not.toHaveBeenCalled();
  });
  it('rejects portal policies that permit immediate cancellation, plan changes or different legal links', async () => {
    h.portal.mockResolvedValue({
      ...portal,
      features: {
        ...portal.features,
        subscription_cancel: { enabled: true, mode: 'immediately' },
      },
    });
    await expect(approvedPlan()).rejects.toMatchObject({
      code: 'BILLING_UNAVAILABLE',
    });
    h.portal.mockResolvedValue({
      ...portal,
      business_profile: { terms_of_service_url: 'https://other.example.test' },
    });
    await expect(approvedPlan()).rejects.toMatchObject({
      code: 'BILLING_UNAVAILABLE',
    });
  });
  it('keeps an approved plan non-purchasable under the checkout kill switch', async () => {
    h.env.CHECKOUT_ENABLED = false;
    expect((await approvedPlan())?.available).toBe(false);
  });
});
