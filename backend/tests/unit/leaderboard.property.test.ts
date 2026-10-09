/**
 * Property-based test for the leaderboard service (task 10.4).
 *
 * **Property 9: Leaderboard math and ordering** — for any set of ledger rows,
 * active members, and period in {today, week, month, all}, each entry's
 * `points` equals the sum of that member's in-period rows and `completedTasks`
 * equals the count of that member's TASK_COMPLETION rows with `points > 0`,
 * entries are ordered by descending `points` then descending `completedTasks`,
 * and a member with no rows yields `points 0` / `completedTasks 0`.
 *
 * **Validates: Requirements 15.1, 15.2, 15.3, 15.4**
 *
 * The leaderboard math (`leaderboard(ctx, period, now?)`) is pure over its two
 * DB inputs: it reads the active roster via `listActiveMembers` and the family's
 * in-period ledger rows via `listPointsInPeriod(familyId, periodStart(period))`.
 * We therefore mock the gamification repository and feed it fast-check-generated
 * members + ledger rows, then assert the returned entries against an independent
 * oracle computed from the same inputs. The mock is faithful to the real call:
 * the service passes the period boundary straight to `listPointsInPeriod`, so
 * returning the generated in-period rows for any boundary matches how the real
 * repository (`created_at >= boundary`) would behave for rows we declare to be
 * in-period. The `all`-period `null` boundary is asserted separately against the
 * real `periodStart` (R15.4).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';

import type {
  FamilyMemberRow,
  LeaderboardPeriod,
  PointsTransactionRow,
  TransactionType,
} from '../../src/shared/types/index.js';
import {
  LEADERBOARD_PERIOD_VALUES,
  TRANSACTION_TYPE_VALUES,
} from '../../src/shared/constants/index.js';
import { periodStart } from '../../src/shared/utils/dates.js';

const listActiveMembers = vi.fn<[string], Promise<FamilyMemberRow[]>>();
const listPointsInPeriod =
  vi.fn<[string, string | null], Promise<PointsTransactionRow[]>>();

// Replace the repository so the service never touches Supabase/env. Only the
// two reads the leaderboard uses are backed; the rest are inert stubs present
// so the module's named exports resolve.
vi.mock('../../src/modules/gamification/gamification.repository.js', () => ({
  listActiveMembers: (familyId: string) => listActiveMembers(familyId),
  listPointsInPeriod: (familyId: string, boundary: string | null) =>
    listPointsInPeriod(familyId, boundary),
  listPoints: vi.fn(),
  listMemberCompletions: vi.fn(),
  listMemberTransactions: vi.fn(),
  findMemberById: vi.fn(),
  listAwards: vi.fn(),
  createAward: vi.fn(),
  findAwardById: vi.fn(),
  updateAward: vi.fn(),
  deactivateAward: vi.fn(),
  redeemAwardRpc: vi.fn(),
}));

const { leaderboard } = await import(
  '../../src/modules/gamification/leaderboard.service.js'
);

const FAMILY_ID = 'fam-1';
const TASK_COMPLETION: TransactionType = 'TASK_COMPLETION';

beforeEach(() => {
  vi.clearAllMocks();
});

/** Build a FamilyMemberRow from a generated id/name/color (always active). */
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
    task_id: raw.transaction_type === TASK_COMPLETION ? `task-${index}` : null,
    points: raw.points,
    transaction_type: raw.transaction_type,
    created_at: '2024-01-02T00:00:00Z',
  };
}

/** A fast-check model of a whole leaderboard scenario. */
interface Scenario {
  members: FamilyMemberRow[];
  rows: PointsTransactionRow[];
  period: LeaderboardPeriod;
}

/** Generator: a distinct set of active members, in-period rows, and a period. */
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
      points: fc.integer({ min: -1000, max: 1000 }),
      transaction_type: fc.constantFrom<TransactionType>(
        ...TRANSACTION_TYPE_VALUES,
      ),
    });

    return fc.record({
      members: fc.constant(members),
      rawRows: fc.array(rowArb, { maxLength: 40 }),
      period: fc.constantFrom<LeaderboardPeriod>(...LEADERBOARD_PERIOD_VALUES),
    });
  })
  .map(({ members, rawRows, period }) => ({
    members,
    rows: rawRows.map((r, i) =>
      ledgerRow(i, r.memberId, {
        points: r.points,
        transaction_type: r.transaction_type,
      }),
    ),
    period,
  }));

/**
 * Independent oracle: compute the expected per-member points sum and
 * TASK_COMPLETION(points>0) count directly from the generated rows.
 */
function expectedTotals(
  rows: PointsTransactionRow[],
): Map<string, { points: number; completedTasks: number }> {
  const totals = new Map<string, { points: number; completedTasks: number }>();
  for (const row of rows) {
    const entry = totals.get(row.member_id) ?? { points: 0, completedTasks: 0 };
    entry.points += row.points;
    if (row.transaction_type === TASK_COMPLETION && row.points > 0) {
      entry.completedTasks += 1;
    }
    totals.set(row.member_id, entry);
  }
  return totals;
}

describe('Feature: family-task-board-backend, Property 9: Leaderboard math and ordering', () => {
  it('each entry sums its member rows, counts positive completions, is zero-filled, and is ordered by points desc then completedTasks desc', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (scenario) => {
        listActiveMembers.mockResolvedValue(scenario.members);
        listPointsInPeriod.mockResolvedValue(scenario.rows);

        // Pin `now` so the period boundary is deterministic and the
        // "called with" assertion below can reproduce it exactly.
        const now = new Date('2024-06-15T12:00:00Z');
        const entries = await leaderboard(
          { familyId: FAMILY_ID },
          scenario.period,
          now,
        );

        // One entry per active member, exactly.
        expect(entries).toHaveLength(scenario.members.length);
        const entryIds = entries.map((e) => e.memberId).sort();
        const memberIds = scenario.members.map((m) => m.id).sort();
        expect(entryIds).toEqual(memberIds);

        const oracle = expectedTotals(scenario.rows);
        const byId = new Map(scenario.members.map((m) => [m.id, m]));

        for (const entry of entries) {
          const expected = oracle.get(entry.memberId);
          // R15.1/R15.4: points == sum of this member's in-period rows.
          // R15.3: completedTasks == count of TASK_COMPLETION rows w/ points>0.
          // A member with no rows is zero-filled (points 0 / completedTasks 0).
          expect(entry.points).toBe(expected?.points ?? 0);
          expect(entry.completedTasks).toBe(expected?.completedTasks ?? 0);
          // Identity fields are carried straight from the member row.
          const m = byId.get(entry.memberId);
          expect(entry.name).toBe(m?.name);
          expect(entry.color).toBe(m?.color ?? null);
        }

        // R15.2: ordered by points desc, then completedTasks desc.
        for (let i = 1; i < entries.length; i += 1) {
          const prev = entries[i - 1];
          const cur = entries[i];
          const ordered =
            prev.points > cur.points ||
            (prev.points === cur.points &&
              prev.completedTasks >= cur.completedTasks);
          expect(ordered).toBe(true);
        }

        // The service passed the real period boundary through to the repo.
        expect(listPointsInPeriod).toHaveBeenCalledWith(
          FAMILY_ID,
          periodStart(scenario.period, now),
        );
      }),
      { numRuns: 200 },
    );
  });

  it("resolves the 'all' period to a null boundary so every ledger row is included (R15.4)", () => {
    expect(periodStart('all')).toBeNull();
  });
});
