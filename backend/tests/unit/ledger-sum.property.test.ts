/**
 * Property-based test for the dashboard's per-member totals (task 10.3).
 *
 * **Property 4: A member's displayed total equals the sum of their ledger
 * rows** — for any active roster and any set of ledger rows, the dashboard's
 * `totals` map reports, for every active member, exactly the arithmetic sum of
 * that member's generated ledger rows' `points` (zero when the member has no
 * rows), and every active member appears as a key in `totals`.
 *
 * **Validates: Requirements 10.1, 16.3**
 *
 * The dashboard's `totals` is pure over its two relevant DB inputs: the active
 * roster via `listActiveMembers` and the family's full ledger via
 * `listAllPoints`. Every ledger row contributes its signed `points` regardless
 * of `transaction_type` (TASK_COMPLETION / MANUAL_ADJUSTMENT add, REVERSAL /
 * REDEMPTION subtract), so the ledger is the single source of truth and the
 * displayed total is just its per-member sum (R16.3).
 *
 * We therefore mock `dashboard.repository.js` and feed fast-check-generated
 * members + ledger rows, then assert the returned `totals` against an
 * independent oracle computed from the same rows. `loadFamilyAndResponsible`
 * returns an inert stub family+responsible (its content is irrelevant to this
 * property) and `listTasksByDueDate` returns `[]` (today's tasks do not affect
 * totals).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';

import type {
  FamilyMemberRow,
  PointsTransactionRow,
  TaskRow,
  TransactionType,
} from '../../src/shared/types/index.js';
import type { FamilyAndResponsible } from '../../src/modules/family/family.repository.js';
import { TRANSACTION_TYPE_VALUES } from '../../src/shared/constants/index.js';

const FAMILY_ID = 'fam-1';
const RESPONSIBLE_USER_ID = 'resp-1';

const loadFamilyAndResponsible =
  vi.fn<[string, string], Promise<FamilyAndResponsible>>();
const listActiveMembers = vi.fn<[string], Promise<FamilyMemberRow[]>>();
const listTasksByDueDate =
  vi.fn<[string, string], Promise<TaskRow[]>>();
const listAllPoints = vi.fn<[string], Promise<PointsTransactionRow[]>>();

// Replace the repository so the service never touches Supabase/env. Only the
// four reads the dashboard uses are backed; `listTasksByWeekStart` (board-only)
// is an inert stub so the module's named exports resolve.
vi.mock('../../src/modules/dashboard/dashboard.repository.js', () => ({
  loadFamilyAndResponsible: (familyId: string, responsibleUserId: string) =>
    loadFamilyAndResponsible(familyId, responsibleUserId),
  listActiveMembers: (familyId: string) => listActiveMembers(familyId),
  listTasksByDueDate: (familyId: string, dueDate: string) =>
    listTasksByDueDate(familyId, dueDate),
  listAllPoints: (familyId: string) => listAllPoints(familyId),
  listTasksByWeekStart: vi.fn(),
}));

const { dashboard } = await import(
  '../../src/modules/dashboard/dashboard.service.js'
);

/** An inert family+responsible stub — irrelevant to the totals property. */
const FAMILY_STUB: FamilyAndResponsible = {
  family: {
    id: FAMILY_ID,
    responsible_user_id: RESPONSIBLE_USER_ID,
    name: 'Stub Family',
    avatar_url: null,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  },
  responsible: {
    id: RESPONSIBLE_USER_ID,
    auth_user_id: 'auth-1',
    name: 'Stub Responsible',
    email: null,
    avatar_url: null,
    relationship: 'MOTHER',
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  },
};

beforeEach(() => {
  vi.clearAllMocks();
});

/** Build an active FamilyMemberRow from a generated id/name/color. */
function member(
  id: string,
  name: string,
  color: string | null,
): FamilyMemberRow {
  return {
    id,
    family_id: FAMILY_ID,
    name,
    member_type: 'CHILD',
    avatar_url: null,
    color,
    birth_year: null,
    active: true,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  };
}

/** A generated ledger row before its member_id is bound to the roster. */
interface RawRow {
  points: number;
  transaction_type: TransactionType;
}

/** Build a PointsTransactionRow from a generated raw row + a chosen member. */
function ledgerRow(
  index: number,
  memberId: string,
  raw: RawRow,
): PointsTransactionRow {
  return {
    id: `tx-${index}`,
    family_id: FAMILY_ID,
    member_id: memberId,
    task_id:
      raw.transaction_type === 'TASK_COMPLETION' ? `task-${index}` : null,
    points: raw.points,
    transaction_type: raw.transaction_type,
    created_at: '2024-01-02T00:00:00Z',
  };
}

/** A fast-check model of a whole dashboard-totals scenario. */
interface Scenario {
  members: FamilyMemberRow[];
  rows: PointsTransactionRow[];
}

/** Generator: a distinct set of active members and their ledger rows. */
const scenarioArb: fc.Arbitrary<Scenario> = fc
  .uniqueArray(
    fc.record({
      id: fc.string({ minLength: 1, maxLength: 8 }),
      name: fc.string({ maxLength: 20 }),
      color: fc.option(fc.string({ maxLength: 7 }), { nil: null }),
    }),
    { selector: (m) => m.id, minLength: 1, maxLength: 6 },
  )
  .chain((rawMembers) => {
    const members = rawMembers.map((m) => member(m.id, m.name, m.color));
    const memberIds = members.map((m) => m.id);

    const rowArb = fc.record({
      memberId: fc.constantFrom(...memberIds),
      // Points may be negative (REVERSAL / REDEMPTION movements).
      points: fc.integer({ min: -1000, max: 1000 }),
      transaction_type: fc.constantFrom<TransactionType>(
        ...TRANSACTION_TYPE_VALUES,
      ),
    });

    return fc.record({
      members: fc.constant(members),
      rawRows: fc.array(rowArb, { maxLength: 40 }),
    });
  })
  .map(({ members, rawRows }) => ({
    members,
    rows: rawRows.map((r, i) =>
      ledgerRow(i, r.memberId, {
        points: r.points,
        transaction_type: r.transaction_type,
      }),
    ),
  }));

/**
 * Independent oracle: the expected per-member points sum computed directly from
 * the generated rows (every row contributes its signed `points`).
 */
function expectedTotals(rows: PointsTransactionRow[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const row of rows) {
    totals.set(row.member_id, (totals.get(row.member_id) ?? 0) + row.points);
  }
  return totals;
}

describe("Feature: family-task-board-backend, Property 4: A member's displayed total equals the sum of their ledger rows", () => {
  it("totals[member.id] equals the sum of that member's ledger rows (zero when none), and every active member is a key", async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (scenario) => {
        loadFamilyAndResponsible.mockResolvedValue(FAMILY_STUB);
        listActiveMembers.mockResolvedValue(scenario.members);
        listTasksByDueDate.mockResolvedValue([]);
        listAllPoints.mockResolvedValue(scenario.rows);

        const payload = await dashboard({
          familyId: FAMILY_ID,
          responsibleUserId: RESPONSIBLE_USER_ID,
        });

        const totals = payload.totals;
        const oracle = expectedTotals(scenario.rows);

        // R16.3: every active member appears as a key in totals.
        const totalKeys = Object.keys(totals).sort();
        const memberIds = scenario.members.map((m) => m.id).sort();
        expect(totalKeys).toEqual(memberIds);

        // R10.1/R16.3: each member's displayed total equals the arithmetic sum
        // of their ledger rows — zero-filled when they have no rows.
        for (const m of scenario.members) {
          expect(totals[m.id]).toBe(oracle.get(m.id) ?? 0);
        }
      }),
      { numRuns: 200 },
    );
  });
});
