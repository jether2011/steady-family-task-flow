/**
 * Points service — ledger reads behind the gamification module (task 10.1).
 *
 * Owns `GET /family/points` (the family ledger, optionally scoped by member and
 * `created_at` range) and `GET /family/members/:id/completions` (one member's
 * completions + ledger rows for the MemberProfile page). The Points_Ledger is
 * the single source of truth for points (R10.1): these reads return the raw
 * ledger/completion rows rather than any stored balance.
 *
 * Identity (`familyId`) always arrives from the caller's resolved session
 * context, never from the request (R23.2); the controller passes it in from
 * `requireFamilyContext`. The member-completions path additionally loads the
 * target member and runs {@link assertOwned}, so a foreign/missing `:id`
 * collapses to `404 NOT_FOUND`. All persistence goes through
 * `gamification.repository.ts`.
 *
 * The leaderboard aggregation lives in `leaderboard.service.ts`; this file is
 * the plain ledger-read half of the module.
 */
import { assertOwned } from '../../middleware/authorization.js';
import type {
  PointsTransactionDTO,
  PointsTransactionRow,
  TaskCompletionRow,
} from '../../shared/types/index.js';
import {
  findMemberById,
  listMemberCompletions,
  listMemberTransactions,
  listPoints,
  type PointsFilter,
} from './gamification.repository.js';

/** The resolved, non-null identity a gamification read needs. */
interface GamificationContext {
  familyId: string;
}

/** The MemberProfile payload: a member's completions and ledger rows. */
export interface MemberCompletionsPayload {
  completions: TaskCompletionRow[];
  transactions: PointsTransactionDTO[];
}

/** Map a `points_transactions` row to the public {@link PointsTransactionDTO} (drops nothing but normalizes the shape). */
export function toPointsTransactionDTO(
  row: PointsTransactionRow,
): PointsTransactionDTO {
  return {
    id: row.id,
    family_id: row.family_id,
    member_id: row.member_id,
    task_id: row.task_id,
    points: row.points,
    transaction_type: row.transaction_type,
    created_at: row.created_at,
  };
}

/**
 * List the session family's ledger rows, optionally scoped by member and/or a
 * `created_at` range (R10.1). Every result is strictly family-scoped; the
 * Points_Ledger is the source of truth, so this returns the raw rows.
 *
 * The `from`/`to` filters were already validated as ISO dates by the
 * `PointsQuery` schema; `memberId` as a uuid. A client-supplied `familyId` was
 * rejected by `.strict()` (R23.2).
 *
 * @param ctx    Session-derived identity.
 * @param filter Optional member/date-range filters.
 */
export async function listTransactions(
  ctx: GamificationContext,
  filter: PointsFilter,
): Promise<PointsTransactionDTO[]> {
  const rows = await listPoints(ctx.familyId, filter);
  return rows.map(toPointsTransactionDTO);
}

/**
 * Load one member's completions + ledger rows for the MemberProfile page
 * (R24.3). The target member is first loaded and checked with
 * {@link assertOwned}: a missing id or one belonging to another family both
 * become `404 NOT_FOUND`, so the route never discloses a foreign member.
 *
 * Returns `{ completions, transactions }` — the exact shape the frontend
 * `points.memberCompletions` consumes.
 *
 * @param ctx      Session-derived identity.
 * @param memberId The member id from the `:id` path param.
 */
export async function memberCompletions(
  ctx: GamificationContext,
  memberId: string,
): Promise<MemberCompletionsPayload> {
  const member = await findMemberById(memberId);
  assertOwned(member?.family_id, ctx.familyId);

  const [completions, transactions] = await Promise.all([
    listMemberCompletions(ctx.familyId, memberId),
    listMemberTransactions(ctx.familyId, memberId),
  ]);

  return {
    completions,
    transactions: transactions.map(toPointsTransactionDTO),
  };
}
