/**
 * Unit tests for the family service (task 5.3).
 *
 * These exercise the single-object "family" DTO illusion the frontend relies
 * on (R2.2): the service composes ONE flat DTO from the two backing rows on
 * read (`families` → `name`/`avatar_url`, `responsible_users` →
 * `relationship`/`responsible_name`) and routes a flat PATCH back to the
 * correct columns on write via the atomic `update_family` RPC. The field-split
 * routing is asserted against the repository call arguments.
 *
 * R2.3 (invalid `relationship` → 422) is a schema concern, so it is proven
 * directly against `FamilyUpdate.safeParse` rather than through the service.
 *
 * The repository is mocked (`family.repository.js`) so the service runs with no
 * Supabase/env, following the same pattern as the other unit suites
 * (leaderboard / template-generate).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  FamilyRow,
  ResponsibleUserRow,
} from '../../src/shared/types/index.js';
import type {
  FamilyAndResponsible,
} from '../../src/modules/family/family.repository.js';
import type { FamilyUpdateInput } from '../../src/modules/family/family.schemas.js';

const loadFamilyAndResponsible =
  vi.fn<[string, string], Promise<FamilyAndResponsible>>();
const updateFamilyAtomic =
  vi.fn<[string, string, FamilyUpdateInput], Promise<void>>();

// Replace the repository so the service never touches Supabase/env.
vi.mock('../../src/modules/family/family.repository.js', () => ({
  loadFamilyAndResponsible: (familyId: string, responsibleUserId: string) =>
    loadFamilyAndResponsible(familyId, responsibleUserId),
  updateFamilyAtomic: (
    familyId: string,
    responsibleUserId: string,
    patch: FamilyUpdateInput,
  ) => updateFamilyAtomic(familyId, responsibleUserId, patch),
}));

const { getFamily, updateFamily } = await import(
  '../../src/modules/family/family.service.js'
);
const { FamilyUpdate } = await import(
  '../../src/modules/family/family.schemas.js'
);

const CTX = { familyId: 'fam-1', responsibleUserId: 'user-1' };

function familyRow(overrides: Partial<FamilyRow> = {}): FamilyRow {
  return {
    id: 'fam-1',
    responsible_user_id: 'user-1',
    name: 'The Smiths',
    avatar_url: 'https://img/avatar.png',
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

function responsibleRow(
  overrides: Partial<ResponsibleUserRow> = {},
): ResponsibleUserRow {
  return {
    id: 'user-1',
    auth_user_id: 'auth-1',
    name: 'Jane Smith',
    email: 'jane@example.com',
    avatar_url: 'https://img/jane.png',
    relationship: 'MOTHER',
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getFamily — composes one DTO from two rows (R2.2)', () => {
  it('takes name/avatar_url from families and relationship/responsible_name from responsible_users', async () => {
    loadFamilyAndResponsible.mockResolvedValue({
      family: familyRow({ name: 'The Smiths', avatar_url: 'https://img/a.png' }),
      responsible: responsibleRow({ relationship: 'FATHER', name: 'John Smith' }),
    });

    const dto = await getFamily(CTX);

    expect(dto).toEqual({
      id: 'fam-1',
      name: 'The Smiths',
      avatar_url: 'https://img/a.png',
      relationship: 'FATHER',
      responsible_name: 'John Smith',
    });
    // Identity flows from the session context, never the body.
    expect(loadFamilyAndResponsible).toHaveBeenCalledWith('fam-1', 'user-1');
  });

  it('preserves nulls on the responsible-side fields (unfilled profile)', async () => {
    loadFamilyAndResponsible.mockResolvedValue({
      family: familyRow({ avatar_url: null }),
      responsible: responsibleRow({ relationship: null, name: null }),
    });

    const dto = await getFamily(CTX);

    expect(dto.avatar_url).toBeNull();
    expect(dto.relationship).toBeNull();
    expect(dto.responsible_name).toBeNull();
  });
});

describe('updateFamily — routes the flat patch and returns the recomposed DTO (R2.2)', () => {
  it('forwards the whole patch to updateFamilyAtomic with session identity', async () => {
    updateFamilyAtomic.mockResolvedValue();
    loadFamilyAndResponsible.mockResolvedValue({
      family: familyRow({ name: 'New Name', avatar_url: 'https://img/new.png' }),
      responsible: responsibleRow({ relationship: 'GUARDIAN', name: 'Guardian G' }),
    });

    const patch: FamilyUpdateInput = {
      name: 'New Name',
      avatar_url: 'https://img/new.png',
      relationship: 'GUARDIAN',
      responsible_name: 'Guardian G',
    };

    const dto = await updateFamily(CTX, patch);

    // The field-split routing is the repository's job; the service must hand it
    // the full flat patch plus the session-derived ids (R2.2 / R2.4).
    expect(updateFamilyAtomic).toHaveBeenCalledWith('fam-1', 'user-1', patch);
    // The DTO is re-read after the write so it reflects persisted state.
    expect(loadFamilyAndResponsible).toHaveBeenCalledWith('fam-1', 'user-1');
    expect(dto).toEqual({
      id: 'fam-1',
      name: 'New Name',
      avatar_url: 'https://img/new.png',
      relationship: 'GUARDIAN',
      responsible_name: 'Guardian G',
    });
  });

  it('routes a families-only patch without touching responsible-side keys', async () => {
    updateFamilyAtomic.mockResolvedValue();
    loadFamilyAndResponsible.mockResolvedValue({
      family: familyRow({ name: 'Renamed' }),
      responsible: responsibleRow(),
    });

    await updateFamily(CTX, { name: 'Renamed' });

    const [, , forwarded] = updateFamilyAtomic.mock.calls[0];
    expect(forwarded).toEqual({ name: 'Renamed' });
    expect(forwarded).not.toHaveProperty('relationship');
    expect(forwarded).not.toHaveProperty('responsible_name');
  });

  it('routes a responsible-only patch (relationship + responsible_name) through unchanged', async () => {
    updateFamilyAtomic.mockResolvedValue();
    loadFamilyAndResponsible.mockResolvedValue({
      family: familyRow(),
      responsible: responsibleRow({ relationship: 'OTHER', name: 'Aunt A' }),
    });

    await updateFamily(CTX, { relationship: 'OTHER', responsible_name: 'Aunt A' });

    const [, , forwarded] = updateFamilyAtomic.mock.calls[0];
    expect(forwarded).toEqual({ relationship: 'OTHER', responsible_name: 'Aunt A' });
    expect(forwarded).not.toHaveProperty('name');
    expect(forwarded).not.toHaveProperty('avatar_url');
  });

  it('is a round-trip: whatever the re-read returns is the composed response', async () => {
    updateFamilyAtomic.mockResolvedValue();
    loadFamilyAndResponsible.mockResolvedValue({
      family: familyRow({ name: 'Echo', avatar_url: null }),
      responsible: responsibleRow({ relationship: 'MOTHER', name: 'Echo Mom' }),
    });

    const dto = await updateFamily(CTX, { name: 'Echo' });

    expect(dto).toEqual({
      id: 'fam-1',
      name: 'Echo',
      avatar_url: null,
      relationship: 'MOTHER',
      responsible_name: 'Echo Mom',
    });
  });
});

describe('FamilyUpdate schema — invalid relationship is 422-bound (R2.3)', () => {
  it('rejects a relationship outside the enum', () => {
    const result = FamilyUpdate.safeParse({ relationship: 'COUSIN' });
    expect(result.success).toBe(false);
  });

  it('accepts each valid relationship value', () => {
    for (const relationship of ['FATHER', 'MOTHER', 'GUARDIAN', 'OTHER']) {
      expect(FamilyUpdate.safeParse({ relationship }).success).toBe(true);
    }
  });

  it('rejects a client-supplied family_id (identity is session-derived, R2.4)', () => {
    const result = FamilyUpdate.safeParse({ name: 'X', family_id: 'fam-2' });
    expect(result.success).toBe(false);
  });

  it('accepts an empty partial patch', () => {
    expect(FamilyUpdate.safeParse({}).success).toBe(true);
  });
});
