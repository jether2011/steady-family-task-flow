import { beforeEach, describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';
const mocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  load: vi.fn(),
  single: vi.fn(),
}));
vi.mock('../../src/modules/entitlements/entitlements.service.js',()=>({resolveEntitlement:async()=>{const row=(await mocks.single()).data;const ready=row.lifecycle==='ESTABLISHED' && row.creation_source==='LEGACY' && row.legacy_access_eligible && !!row.profile_completed_at;return {state:ready?'LEGACY':'DRAFT',reason:ready?'LEGACY':'PAYMENT_PENDING',effectiveUntil:null,version:100,canRead:ready,canWrite:ready,ownerDeadlines:null};}}));
vi.mock('../../src/modules/access/access.service.js', () => ({
  resolveMembership: mocks.resolve,
}));
vi.mock('../../src/modules/family/family.repository.js', () => ({
  loadFamilyAndResponsible: mocks.load,
}));
vi.mock('../../src/config/supabase.js', () => ({
  getServiceRoleClient: () => ({
    from: () => ({ select: () => ({ eq: () => ({ single: mocks.single }) }) }),
  }),
}));
import { bootstrapMe } from '../../src/modules/auth/auth.service.js';
beforeEach(() => vi.clearAllMocks());
describe('membership resolution replaces implicit family bootstrap', () => {
  it('never creates a responsible profile or family for unassociated verified subjects', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uuid(),
        fc.integer({ min: 1, max: 8 }),
        async (id, count) => {
          mocks.resolve.mockResolvedValue({
            state: 'NO_ACCESS',
            user: { id, display_name: null, avatar_url: null },
            membership: null,
          });
          for (let i = 0; i < count; i++)
            expect(await bootstrapMe(id, {})).toEqual({
              state: 'NO_ACCESS',
              user: { id, displayName: null, avatarUrl: null },
              family: null,
              membership: null,
              capabilities: [],
              signupAvailable: false,
            });
        },
      ),
    );
    expect(mocks.load).not.toHaveBeenCalled();
    expect(mocks.single).not.toHaveBeenCalled();
  });
  it('revoked bindings do not fall through to owner bootstrap', async () => {
    mocks.resolve.mockResolvedValue({
      state: 'REVOKED',
      user: { id: 'user', display_name: null, avatar_url: null },
      membership: null,
    });
    expect((await bootstrapMe('auth', {})).state).toBe('REVOKED');
    expect(mocks.load).not.toHaveBeenCalled();
  });
  it('maps the membership role, participant and version without provider metadata permissions', async () => {
    mocks.resolve.mockResolvedValue({
      state: 'READY',
      user: { id: 'app', display_name: 'Member', avatar_url: null },
      membership: {
        id: 'membership',
        family_id: 'family',
        member_id: 'member',
        role: 'MEMBER',
        access_version: 3,
      },
    });
    mocks.single.mockResolvedValue({
      data: {
        responsible_user_id: 'owner',
        lifecycle: 'ESTABLISHED',
        creation_source: 'LEGACY',
        legacy_access_eligible: true,
        profile_completed_at: '2026-10-01T00:00:00Z',
      },
      error: null,
    });
    mocks.load.mockResolvedValue({
      family: { id: 'family', name: 'Existing', avatar_url: null },
      responsible: { name: 'Owner', relationship: 'MOTHER' },
    });
    const me = await bootstrapMe('auth', { name: 'OWNER' });
    expect(me.membership?.role).toBe('MEMBER');
    expect(me.capabilities).not.toContain('family:manage');
    expect(me.family?.id).toBe('family');
  });
});

describe('tenant bootstrap lifecycle', () => {
  it.each([
    ['DRAFT', 'SELF_SERVICE', false, null, 'ONBOARDING_REQUIRED'],
    ['DRAFT', 'SELF_SERVICE', false, '2026-10-01', 'PAYMENT_REQUIRED'],
    ['ESTABLISHED', 'SELF_SERVICE', false, '2026-10-01', 'PAYMENT_REQUIRED'],
    ['ESTABLISHED', 'LEGACY', false, '2026-10-01', 'PAYMENT_REQUIRED'],
    ['ESTABLISHED', 'LEGACY', true, '2026-10-01', 'READY'],
  ] as const)(
    'routes %s %s eligible=%s profile=%s to %s',
    async (
      lifecycle,
      creation_source,
      legacy_access_eligible,
      profile_completed_at,
      expected,
    ) => {
      mocks.resolve.mockResolvedValue({
        state: 'READY',
        user: { id: 'app', display_name: null, avatar_url: null },
        membership: {
          id: 'm',
          family_id: 'family',
          role: 'OWNER',
          member_id: null,
          access_version: 1,
        },
      });
      mocks.single.mockResolvedValue({
        data: {
          responsible_user_id: 'owner',
          lifecycle,
          creation_source,
          legacy_access_eligible,
          profile_completed_at,
        },
        error: null,
      });
      mocks.load.mockResolvedValue({
        family: { id: 'family', name: 'Family', avatar_url: null },
        responsible: { name: 'Owner', relationship: 'OTHER' },
      });
      const result = await bootstrapMe('auth', {});
      expect(result.state).toBe(expected);
      if (expected !== 'READY')
        expect(result.capabilities).toEqual(['owner:onboarding','billing:manage']);
    },
  );
});
