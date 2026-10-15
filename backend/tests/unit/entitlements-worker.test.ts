import { beforeEach, describe, it, expect, vi } from 'vitest';
const h = vi.hoisted(() => ({
  rpc: vi.fn(),
  env: {
    ENTITLEMENT_POLICY_VERSION: undefined as string | undefined,
    ENTITLEMENT_POLICY_APPROVAL: 'fixture',
    RENEWAL_GRACE_DAYS: 7,
    PROVIDER_OUTAGE_TOLERANCE_HOURS: 24,
    ENTITLEMENT_EXCEPTION_POLICY: 'RESTRICT',
    STRIPE_ACCOUNT_ID: 'acct_fixture',
    STRIPE_PRICE_ID: 'price_fixture',
    BILLING_MEMBER_LIMIT: 'unlimited',
    ENTITLEMENT_ENFORCEMENT_ENABLED: false,
    ENTITLEMENT_TRIALS_ENABLED: false,
    STRIPE_MODE: 'TEST',
  },
}));
vi.mock('../../src/config/env.js', () => ({ env: h.env }));
vi.mock('../../src/modules/access/access.repository.js', () => ({
  accessRpc: h.rpc,
}));
import {
  publishEntitlementPolicy,
  projectEntitlements,
} from '../../src/modules/entitlements/entitlements.worker.js';
beforeEach(() => {
  vi.clearAllMocks();
  h.env.ENTITLEMENT_POLICY_VERSION = undefined;
});
describe('durable entitlement worker', () => {
  it('does not invent/publish a policy when configuration is absent', async () => {
    await publishEntitlementPolicy();
    expect(h.rpc).not.toHaveBeenCalled();
  });
  it('publishes explicit approved mode, merchant, price and policy durations', async () => {
    h.env.ENTITLEMENT_POLICY_VERSION = 'approved-test';
    await publishEntitlementPolicy();
    expect(h.rpc).toHaveBeenCalledWith('entitlement_configure', {
      p: expect.objectContaining({
        version: 'approved-test',
        mode: 'TEST',
        merchant: 'acct_fixture',
        priceId: 'price_fixture',
        graceDays: 7,
        outageHours: 24,
        enforcementEnabled: false,
        trialsEnabled: false,
        memberLimit: null,
      }),
    });
  });
  it('requeues a failed projection with the exact durable lease', async () => {
    h.rpc.mockImplementation(async (name) => {
      if (name === 'entitlement_claim')
        return { family_id: 'family', lease_token: 'lease' };
      if (name === 'entitlement_project')
        throw new Error('storage unavailable');
      return null;
    });
    expect(await projectEntitlements()).toBe(true);
    expect(h.rpc).toHaveBeenCalledWith('entitlement_retry', {
      p_family: 'family',
      p_token: 'lease',
    });
  });
  it('is idle when another worker owns the due jobs', async () => {
    h.rpc.mockResolvedValue(null);
    expect(await projectEntitlements()).toBe(false);
    expect(h.rpc).toHaveBeenCalledTimes(1);
  });
});
