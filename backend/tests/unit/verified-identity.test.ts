import { beforeEach, describe, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ lookup: vi.fn(), rpc: vi.fn() }));
vi.hoisted(() =>
  Object.assign(process.env, {
    SUPABASE_URL: 'https://project.supabase.co',
    SUPABASE_PUBLISHABLE_KEY: 'test',
    SUPABASE_SECRET_KEY: 'test',
    CORS_ORIGIN: 'http://localhost',
    MEMBERSHIP_ACCESS_ENABLED: 'true',
  }),
);
vi.mock('../../src/config/supabase.js', () => ({
  getServiceRoleClient: () => ({
    auth: { admin: { getUserById: mock.lookup } },
    rpc: mock.rpc,
  }),
}));
import {
  resolveMembership,
  verifiedIdentity,
} from '../../src/modules/access/access.service.js';
beforeEach(() => {
  mock.lookup.mockReset();
  mock.rpc.mockReset();
  mock.rpc.mockResolvedValue({ data: { state: 'NO_ACCESS' }, error: null });
});
describe('provider identity evidence', () => {
  it('ignores unverified email and forged metadata role/family', async () => {
    mock.lookup.mockResolvedValue({
      data: {
        user: {
          id: 'subject',
          email: 'manager@example.test',
          email_confirmed_at: null,
          user_metadata: {
            email_verified: true,
            role: 'OWNER',
            family_id: 'other',
          },
        },
      },
      error: null,
    });
    await resolveMembership('subject');
    expect(mock.rpc).toHaveBeenCalledWith('resolve_membership', {
      p_auth: 'subject',
      p_email: null,
      p_name: null,
      p_avatar: null,
      p_claim: true,
    });
  });
  it('uses only the provider-confirmed mailbox for reservation matching', async () => {
    mock.lookup.mockResolvedValue({
      data: {
        user: {
          id: 'subject',
          email: 'trusted@example.test',
          email_confirmed_at: '2026-10-11',
          user_metadata: { email: 'forged@example.test' },
        },
      },
      error: null,
    });
    expect((await verifiedIdentity('subject')).email).toBe(
      'trusted@example.test',
    );
  });
  it('fails closed on unavailable identity provider', async () => {
    mock.lookup.mockResolvedValue({
      data: { user: null },
      error: new Error('unavailable'),
    });
    await expect(resolveMembership('subject')).rejects.toMatchObject({
      code: 'IDENTITY_UNAVAILABLE',
      http: 503,
    });
    expect(mock.rpc).not.toHaveBeenCalled();
  });
  it('rejects a provider subject mismatch', async () => {
    mock.lookup.mockResolvedValue({
      data: { user: { id: 'different' } },
      error: null,
    });
    await expect(resolveMembership('subject')).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });
});
