/**
 * Leaderboard service — the ledger-sum ranking behind
 * `GET /family/leaderboard` (task 10.1).
 *
 * This is a faithful port of the frontend `familyUtils.computeLeaderboard`,
 * moved server-side so the Points_Ledger stays the single source of truth
 * (R10.1). For a chosen `period` it computes, per ACTIVE member:
 *
 *   - `points`         — the SUM of that member's ledger rows within the period.
 *     ALL rows contribute regardless of `transaction_type`: TASK_COMPLETION and
 *     MANUAL_ADJUSTMENT are positive, REVERSAL and REDEMPTION are negative, so
 *     summing them yields the member's net balance over the window (R15.1),
 *     exactly as `computeLeaderboard` does (`totals[...].points += t.points`).
 *   - `completedTasks` — the COUNT of that member's TASK_COMPLETION rows with
 *     `points > 0` within the period (R15.3). A zero-point completion writes no
 *     ledger row (R10.3) and so is never counted; the `points > 0` guard
 *     mirrors the original and is defensive besides.
 *
 * Entries are produced only for ACTIVE members (R15.1; mirrors
 * `computeLeaderboard`'s `.filter(m => m.active)`), then ranked by `points`
 * descending, breaking ties by `completedTasks` descending (R15.2).
 *
 * The period lower bound is a UTC instant from the shared
 * {@link periodStart}: `today`/`week`/`month` filter `created_at >= boundary`,
 * while `all` uses a `null` boundary so EVERY ledger row is included regardless
 * of date (R15.4). An invalid `period` never reaches here — the route's
 * `z.enum(LEADERBOARD_PERIOD_VALUES)` schema rejects it as `422` first (R15.5).
 */
import type {
  LeaderboardEntry,
  LeaderboardPeriod,
  PointsTransactionRow,
} from '../../shared/types/index.js';
import { periodStart } from '../../shared/utils/dates.js';
import {
  listActiveMembers,
  listPointsInPeriod,
} from './gamification.repository.js';

/** The resolved, non-null identity a leaderboard read needs. */
interface GamificationContext {
  familyId: string;
}

/** The transaction_type that represents an earned task award (R15.3). */
const TASK_COMPLETION = 'TASK_COMPLETION';

/** Per-member running totals accumulated from the ledger. */
interface MemberTotals {
  points: number;
  completedTasks: number;
}

/**
 * Fold the family's in-period ledger rows into per-member totals, keyed by
 * `member_id`. Mirrors the `computeLeaderboard` reducer: every row adds its
 * `points` to the member's running total, and a TASK_COMPLETION with
 * `points > 0` additionally increments `completedTasks` (R15.1/R15.3).
 */
function accumulateTotals(
  rows: PointsTransactionRow[],
): Map<string, MemberTotals> {
  const totals = new Map<string, MemberTotals>();

  for (const row of rows) {
    let entry = totals.get(row.member_id);
    if (entry === undefined) {
      entry = { points: 0, completedTasks: 0 };
      totals.set(row.member_id, entry);
    }
    entry.points += row.points;
    if (row.transaction_type === TASK_COMPLETION && row.points > 0) {
      entry.completedTasks += 1;
    }
  }

  return totals;
}

/**
 * Compute the ranked leaderboard for the session family and `period` (R15).
 *
 * Reads the active roster and the family's in-period ledger rows in parallel,
 * folds the rows into per-member totals, then emits one entry per active member
 * (zero-filled when the member has no in-period rows) ordered by `points` desc,
 * then `completedTasks` desc (R15.2). The `now` reference is injectable so the
 * period boundary is deterministic in tests.
 *
 * @param ctx    Session-derived identity.
 * @param period The validated aggregation window.
 * @param now    Reference instant for the period boundary (defaults to now).
 */
export async function leaderboard(
  ctx: GamificationContext,
  period: LeaderboardPeriod,
  now: Date = new Date(),
): Promise<LeaderboardEntry[]> {
  const boundary = periodStart(period, now);

  const [members, rows] = await Promise.all([
    listActiveMembers(ctx.familyId),
    listPointsInPeriod(ctx.familyId, boundary),
  ]);

  const totals = accumulateTotals(rows);

  return members
    .map((member): LeaderboardEntry => {
      const entry = totals.get(member.id);
      return {
        memberId: member.id,
        name: member.name,
        color: member.color,
        points: entry?.points ?? 0,
        completedTasks: entry?.completedTasks ?? 0,
      };
    })
    .sort(
      (a, b) =>
        b.points - a.points || b.completedTasks - a.completedTasks,
    );
}
