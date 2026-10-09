/**
 * Unit tests for the member service (task 5.3).
 *
 * These cover the members CRUD + soft-delete rules:
 *   - `create` defaults `active` to true and maps the row through to the DTO
 *     (R3.2 — the insert omits `active`, so the DB default surfaces).
 *   - `deactivate` is a SOFT delete: it calls the repo's `deactivateMember`
 *     (an `UPDATE active=false`), NOT a hard delete, and the row is retained so
 *     historical Task_Completion / Points_Ledger references stay intact (R3.4).
 *   - a member in another family collapses to `404 NOT_FOUND` for both
 *     `update` and `deactivate` via `assertOwned`, and the guarded mutation is
 *     never reached (R3.6).
 *
 * R3.5 (invalid `member_type` → 422) is a schema concern, so it is proven
 * directly against `MemberCreate.safeParse` rather than through the service.
 *
 * The repository is mocked (`member.repository.js`) so the service runs with no
 * Supabase/env, following the same pattern as the other unit suites.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { FamilyMemberRow } from '../../src/shared/types/index.js';
import type {
  MemberCreateInput,
  MemberUpdateInput,
} from '../../src/modules/members/member.schemas.js';
import { NotFound } from '../../src/shared/errors/index.js';

const listMembers = vi.fn<[string, boolean], Promise<FamilyMemberRow[]>>();
const createMember =
  vi.fn<[string, MemberCreateInput], Promise<FamilyMemberRow>>();
const findMemberById = vi.fn<[string], Promise<FamilyMemberRow | null>>();
const updateMember =
  vi.fn<[string, string, MemberUpdateInput], Promise<FamilyMemberRow>>();
const deactivateMember =
  vi.fn<[string, string], Promise<FamilyMemberRow>>();

// Replace the repository so the service never touches Supabase/env.
vi.mock('../../src/modules/members/member.repository.js', () => ({
  listMembers: (familyId: string, activeOnly: boolean) =>
    listMembers(familyId, activeOnly),
  createMember: (familyId: string, input: MemberCreateInput) =>
    createMember(familyId, input),
  findMemberById: (id: string) => findMemberById(id),
  updateMember: (familyId: string, id: string, patch: MemberUpdateInput) =>
    updateMember(familyId, id, patch),
  deactivateMember: (familyId: string, id: string) =>
    deactivateMember(familyId, id),
}));

const memberService = await import(
  '../../src/modules/members/member.service.js'
);
const { MemberCreate } = await import(
  '../../src/modules/members/member.schemas.js'
);

const FAMILY_A = 'fam-A';
const FAMILY_B = 'fam-B';
const CTX = { familyId: FAMILY_A };

function memberRow(overrides: Partial<FamilyMemberRow> = {}): FamilyMemberRow {
  return {
    id: 'mem-1',
    family_id: FAMILY_A,
    name: 'Kid One',
    member_type: 'CHILD',
    avatar_url: null,
    color: '#ff0000',
    birth_year: 2015,
    active: true,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('create — defaults active true and maps to the DTO (R3.2)', () => {
  it('maps the created row through to the DTO (drops timestamps) with active=true', async () => {
    createMember.mockResolvedValue(memberRow({ id: 'mem-9', active: true }));

    const body: MemberCreateInput = { name: 'Kid One', member_type: 'CHILD' };
    const dto = await memberService.create(CTX, body);

    // Insert is keyed by the session family id, never a body value (R3.2).
    expect(createMember).toHaveBeenCalledWith(FAMILY_A, body);
    expect(dto).toEqual({
      id: 'mem-9',
      family_id: FAMILY_A,
      name: 'Kid One',
      member_type: 'CHILD',
      avatar_url: null,
      color: '#ff0000',
      birth_year: 2015,
      active: true,
    });
    // The DTO carries no timestamps.
    expect(dto).not.toHaveProperty('created_at');
    expect(dto).not.toHaveProperty('updated_at');
  });
});

describe('deactivate — soft delete retains the row (R3.4)', () => {
  it('calls the repo deactivate (UPDATE active=false), not a hard delete, and returns the retained row', async () => {
    findMemberById.mockResolvedValue(memberRow({ id: 'mem-5', active: true }));
    deactivateMember.mockResolvedValue(memberRow({ id: 'mem-5', active: false }));

    const dto = await memberService.deactivate(CTX, 'mem-5');

    // Ownership is checked first, then the soft-delete repo call runs.
    expect(findMemberById).toHaveBeenCalledWith('mem-5');
    expect(deactivateMember).toHaveBeenCalledWith(FAMILY_A, 'mem-5');
    // The row is RETAINED — it comes back with active=false, not removed.
    expect(dto.id).toBe('mem-5');
    expect(dto.active).toBe(false);
  });
});

describe('ownership — foreign/missing id → 404 for update + deactivate (R3.6)', () => {
  it('update on another family\'s member throws NotFound and never mutates', async () => {
    findMemberById.mockResolvedValue(memberRow({ family_id: FAMILY_B }));

    await expect(
      memberService.update(CTX, 'mem-1', { name: 'hijack' }),
    ).rejects.toBeInstanceOf(NotFound);
    expect(updateMember).not.toHaveBeenCalled();
  });

  it('deactivate on another family\'s member throws NotFound and never soft-deletes', async () => {
    findMemberById.mockResolvedValue(memberRow({ family_id: FAMILY_B }));

    await expect(
      memberService.deactivate(CTX, 'mem-1'),
    ).rejects.toBeInstanceOf(NotFound);
    expect(deactivateMember).not.toHaveBeenCalled();
  });

  it('a missing member (null) is indistinguishable from a foreign one — both 404', async () => {
    findMemberById.mockResolvedValue(null);

    await expect(
      memberService.update(CTX, 'mem-x', { name: 'x' }),
    ).rejects.toBeInstanceOf(NotFound);
    await expect(
      memberService.deactivate(CTX, 'mem-x'),
    ).rejects.toBeInstanceOf(NotFound);
    expect(updateMember).not.toHaveBeenCalled();
    expect(deactivateMember).not.toHaveBeenCalled();
  });

  it('update on an owned member proceeds to the repo and returns the DTO', async () => {
    findMemberById.mockResolvedValue(memberRow({ id: 'mem-1', family_id: FAMILY_A }));
    updateMember.mockResolvedValue(memberRow({ id: 'mem-1', name: 'Renamed' }));

    const dto = await memberService.update(CTX, 'mem-1', { name: 'Renamed' });

    expect(updateMember).toHaveBeenCalledWith(FAMILY_A, 'mem-1', { name: 'Renamed' });
    expect(dto.name).toBe('Renamed');
  });
});

describe('MemberCreate schema — invalid member_type is 422-bound (R3.5)', () => {
  it('rejects a member_type outside the enum', () => {
    const result = MemberCreate.safeParse({ name: 'X', member_type: 'ROBOT' });
    expect(result.success).toBe(false);
  });

  it('accepts each valid member_type value', () => {
    for (const member_type of ['PARENT', 'CHILD', 'DEPENDENT']) {
      expect(
        MemberCreate.safeParse({ name: 'X', member_type }).success,
      ).toBe(true);
    }
  });

  it('rejects a client-supplied family_id and active (both server-derived, R3.2)', () => {
    expect(
      MemberCreate.safeParse({ name: 'X', member_type: 'CHILD', family_id: 'fam-2' })
        .success,
    ).toBe(false);
    expect(
      MemberCreate.safeParse({ name: 'X', member_type: 'CHILD', active: false })
        .success,
    ).toBe(false);
  });
});
