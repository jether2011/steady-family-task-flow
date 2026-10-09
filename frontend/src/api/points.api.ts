/**
 * Points / leaderboard domain API module (gamification reads).
 *
 * Wraps the ledger-read portion of the backend "Gamification module" with
 * typed functions calling `client.ts`.
 *
 * Response-envelope assumptions (design "REST API Design"):
 *   GET /family/points                    -> { transactions: PointsTransaction[] } (-> array)
 *   GET /family/leaderboard               -> { entries: LeaderboardEntry[] }       (-> array)
 *   GET /family/members/:id/completions   -> { completions, transactions }          (whole)
 */

import { get } from './client';
import type {
  PointsTransaction,
  PointsFilter,
  LeaderboardEntry,
  LeaderboardPayload,
  LeaderboardPeriod,
  MemberProfilePayload,
} from './types';

interface TransactionsEnvelope {
  transactions: PointsTransaction[];
}

/**
 * `GET /family/points` — ledger entries, optionally scoped by member/date
 * range. null/undefined filter fields are dropped by the query serializer.
 * Unwraps `{ transactions }` → PointsTransaction[].
 */
export async function list(
  filter: PointsFilter = {},
  signal?: AbortSignal,
): Promise<PointsTransaction[]> {
  const res = await get<TransactionsEnvelope>(
    '/family/points',
    { ...filter },
    signal,
  );
  return res.transactions;
}

/**
 * `GET /family/leaderboard` — ranked member totals for the given `period`
 * (defaults omitted → backend default). Unwraps `{ entries }` →
 * LeaderboardEntry[].
 */
export async function leaderboard(
  period?: LeaderboardPeriod,
  signal?: AbortSignal,
): Promise<LeaderboardEntry[]> {
  const res = await get<LeaderboardPayload>(
    '/family/leaderboard',
    period === undefined ? undefined : { period },
    signal,
  );
  return res.entries;
}

/**
 * `GET /family/members/:id/completions` — member profile: that member's
 * completions and ledger transactions. Returned whole as `MemberProfilePayload`
 * since both arrays are consumed together.
 */
export function memberCompletions(
  id: string,
  signal?: AbortSignal,
): Promise<MemberProfilePayload> {
  return get<MemberProfilePayload>(
    `/family/members/${id}/completions`,
    undefined,
    signal,
  );
}

export const points = {
  list,
  leaderboard,
  memberCompletions,
};
