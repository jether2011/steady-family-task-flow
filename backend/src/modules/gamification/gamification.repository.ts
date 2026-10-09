/**
 * Gamification repository — the ONLY layer in this module that talks to
 * Supabase. Backs the ledger-read + leaderboard slice (task 10.1):
 *   - {@link listPoints} reads the family's ledger, optionally scoped by member
 *     and/or a `created_at` range (R10.1, the ledger-read endpoint).
 *   - {@link listPointsInPeriod} reads every ledger row of the family created at
 *     or after a UTC period boundary (or all rows when the boundary is `null`),
 *     the raw input the leaderboard math sums over (R15.1/R15.4).
 *   - {@link listActiveMembers} reads the family's ACTIVE roster — the only
 *     members a leaderboard entry is produced for (R15.1, mirrors
 *     `computeLeaderboard`'s `active` filter).
 *   - {@link listMemberCompletions} / {@link listMemberTransactions} read a
 *     single member's completions + ledger rows for the MemberProfile payload.
 *
 * ### Which Supabase client
 *
 * Every operation uses the **service-role client**, matching every other module
 * and the context resolver. All queries are keyed strictly by the
 * session-derived `familyId`, so no cross-family row is reachable even though
 * RLS is bypassed; the member-scoped reads additionally filter by `member_id` /
 * `completed_by_member_id` after the service has already asserted the member
 * belongs to the family.
 *
 * Task 10.2 (awards CRUD + redeem) adds its reads/writes here — notably the
 * awards list/find/insert/update/deactivate and the member-balance read the
 * redemption guard needs — without disturbing these ledger reads.
 */
import { PostgrestError } from '@supabase/supabase-js';

import type {
  AwardRow,
  FamilyMemberRow,
  PointsTransactionRow,
  TaskCompletionRow,
} from '../../shared/types/index.js';
import { getServiceRoleClient } from '../../config/supabase.js';
import { InsufficientPoints, NotFound } from '../../shared/errors/index.js';
import type {
  AwardCreateInput,
  AwardUpdateInput,
} from './gamification.schemas.js';

/** Columns selected for a points-ledger row. */
const POINTS_COLUMNS =
  'id, family_id, member_id, task_id, points, transaction_type, created_at';

/** Columns selected for an award row. */
const AWARD_COLUMNS =
  'id, family_id, title, description, points_cost, icon, color, active, created_at, updated_at';

/** Columns selected for a task-completion row. */
const COMPLETION_COLUMNS =
  'id, task_id, family_id, completed_by_user_id, completed_by_member_id, completed_at';

/** Columns selected for a family-member row (active-roster read). */
const MEMBER_COLUMNS =
  'id, family_id, name, member_type, avatar_url, color, birth_year, active, created_at, updated_at';

/**
 * Optional member/date filters for the ledger-read endpoint
 * (`GET /family/points`). The `| undefined` on each field matches the
 * Zod-inferred `PointsQueryInput` shape under `exactOptionalPropertyTypes`, so
 * the parsed query can be passed straight through.
 */
export interface PointsFilter {
  /** Restrict to a single member's ledger rows when set. */
  memberId?: string | undefined;
  /** Inclusive lower bound on `created_at` (`>=`) when set. */
  from?: string | undefined;
  /** Inclusive upper bound on `created_at` (`<=`) when set. */
  to?: string | undefined;
}

/**
 * List a family's ledger rows, optionally scoped by member and/or a
 * `created_at` range (R10.1). Always keyed by the session-derived `familyId`.
 *
 * `from`/`to` are applied as inclusive bounds (`gte`/`lte`) on `created_at`;
 * `memberId` restricts to a single member. Omitted filters impose no
 * constraint. Ordered newest-first so the frontend PointsHistory list reads top
 * to bottom chronologically.
 *
 * @param familyId Session-derived `families.id`.
 * @param filter   Optional member/date-range filters.
 */
export async function listPoints(
  familyId: string,
  filter: PointsFilter,
): Promise<PointsTransactionRow[]> {
  const db = getServiceRoleClient();

  let query = db
    .from('points_transactions')
    .select(POINTS_COLUMNS)
    .eq('family_id', familyId);

  if (filter.memberId !== undefined) {
    query = query.eq('member_id', filter.memberId);
  }
  if (filter.from !== undefined) {
    query = query.gte('created_at', filter.from);
  }
  if (filter.to !== undefined) {
    query = query.lte('created_at', filter.to);
  }

  const { data, error } = await query
    .order('created_at', { ascending: false })
    .returns<PointsTransactionRow[]>();

  if (error) {
    throw error;
  }

  return data ?? [];
}

/**
 * List every ledger row of the family within a period — the raw input the
 * leaderboard math sums over (R15.1).
 *
 * When `periodStart` is a `YYYY-MM-DD`/ISO string, only rows with
 * `created_at >= periodStart` are returned; when it is `null` (the `all`
 * period) every row is returned regardless of date (R15.4). The result is NOT
 * member-filtered — the service buckets by `member_id` in memory, exactly as
 * the ported `computeLeaderboard` does.
 *
 * @param familyId    Session-derived `families.id`.
 * @param periodStart Inclusive UTC lower bound on `created_at`, or `null` for all.
 */
export async function listPointsInPeriod(
  familyId: string,
  periodStart: string | null,
): Promise<PointsTransactionRow[]> {
  const db = getServiceRoleClient();

  let query = db
    .from('points_transactions')
    .select(POINTS_COLUMNS)
    .eq('family_id', familyId);

  if (periodStart !== null) {
    query = query.gte('created_at', periodStart);
  }

  const { data, error } = await query.returns<PointsTransactionRow[]>();

  if (error) {
    throw error;
  }

  return data ?? [];
}

/**
 * List the ACTIVE members of a family — the only members a leaderboard entry is
 * produced for (R15.1; mirrors `computeLeaderboard`'s `.filter(m => m.active)`).
 * Ordered by `created_at` for a stable base order before the points/tasks sort.
 *
 * @param familyId Session-derived `families.id`.
 */
export async function listActiveMembers(
  familyId: string,
): Promise<FamilyMemberRow[]> {
  const db = getServiceRoleClient();

  const { data, error } = await db
    .from('family_members')
    .select(MEMBER_COLUMNS)
    .eq('family_id', familyId)
    .eq('active', true)
    .order('created_at', { ascending: true })
    .returns<FamilyMemberRow[]>();

  if (error) {
    throw error;
  }

  return data ?? [];
}

/**
 * List a single member's completions within the family (MemberProfile payload).
 * Scoped by `family_id` + `completed_by_member_id`; the service has already
 * asserted the member belongs to the family. Ordered newest-first.
 *
 * @param familyId Session-derived `families.id`.
 * @param memberId The member whose completions to read.
 */
export async function listMemberCompletions(
  familyId: string,
  memberId: string,
): Promise<TaskCompletionRow[]> {
  const db = getServiceRoleClient();

  const { data, error } = await db
    .from('task_completions')
    .select(COMPLETION_COLUMNS)
    .eq('family_id', familyId)
    .eq('completed_by_member_id', memberId)
    .order('completed_at', { ascending: false })
    .returns<TaskCompletionRow[]>();

  if (error) {
    throw error;
  }

  return data ?? [];
}

/**
 * List a single member's ledger rows within the family (MemberProfile payload).
 * Scoped by `family_id` + `member_id`; the service has already asserted the
 * member belongs to the family. Ordered newest-first.
 *
 * @param familyId Session-derived `families.id`.
 * @param memberId The member whose ledger rows to read.
 */
export async function listMemberTransactions(
  familyId: string,
  memberId: string,
): Promise<PointsTransactionRow[]> {
  const db = getServiceRoleClient();

  const { data, error } = await db
    .from('points_transactions')
    .select(POINTS_COLUMNS)
    .eq('family_id', familyId)
    .eq('member_id', memberId)
    .order('created_at', { ascending: false })
    .returns<PointsTransactionRow[]>();

  if (error) {
    throw error;
  }

  return data ?? [];
}

/**
 * Load a single member by id, or `null` when no such row exists.
 *
 * Deliberately NOT scoped by `family_id`: the caller passes the row to
 * `assertOwned`, which collapses "not found" and "foreign family" into one
 * `404` so existence is never leaked (used by the member-completions route).
 *
 * @param id The `family_members.id` from the `:id` path param.
 */
export async function findMemberById(
  id: string,
): Promise<FamilyMemberRow | null> {
  const db = getServiceRoleClient();

  const { data, error } = await db
    .from('family_members')
    .select(MEMBER_COLUMNS)
    .eq('id', id)
    .maybeSingle<FamilyMemberRow>();

  if (error) {
    throw error;
  }

  return data;
}

/* ------------------------------------------------------------------------- *
 * Awards CRUD + redemption (task 10.2)                                       *
 * ------------------------------------------------------------------------- */

/**
 * List a family's awards (R18.1). Always keyed by the session-derived
 * `familyId`, so no cross-family award is reachable. Ordered by `created_at`
 * for a stable list. Soft-deleted awards (`active = false`) are retained and
 * still returned — the frontend decides how to present them.
 *
 * @param familyId Session-derived `families.id`.
 */
export async function listAwards(familyId: string): Promise<AwardRow[]> {
  const db = getServiceRoleClient();

  const { data, error } = await db
    .from('awards')
    .select(AWARD_COLUMNS)
    .eq('family_id', familyId)
    .order('created_at', { ascending: true })
    .returns<AwardRow[]>();

  if (error) {
    throw error;
  }

  return data ?? [];
}

/**
 * Insert a new award into the session's family (R18.2).
 *
 * `family_id` is taken from the session context, never the request (R23.2);
 * `active` is omitted from the insert so the column default of `true` applies.
 * Optional `description`/`color` default to `null` and `icon` is left to the
 * column default when absent. The inserted row is selected back so the service
 * can return the created award.
 *
 * @param familyId Session-derived `families.id`.
 * @param input    The validated create body.
 */
export async function createAward(
  familyId: string,
  input: AwardCreateInput,
): Promise<AwardRow> {
  const db = getServiceRoleClient();

  const insert: Record<string, unknown> = {
    family_id: familyId,
    title: input.title,
    points_cost: input.points_cost,
    description: input.description ?? null,
    color: input.color ?? null,
  };
  // Only set `icon` when provided so the column default applies otherwise.
  if (input.icon !== undefined) {
    insert.icon = input.icon;
  }

  const { data, error } = await db
    .from('awards')
    .insert(insert)
    .select(AWARD_COLUMNS)
    .single<AwardRow>();

  if (error) {
    throw error;
  }

  return data;
}

/**
 * Load a single award by id, or `null` when no such row exists.
 *
 * Deliberately NOT scoped by `family_id`: the caller passes the row to
 * `assertOwned`, which collapses "not found" and "foreign family" into one
 * `404` so existence is never leaked (R18.10).
 *
 * @param id The `awards.id` from the `:id` path param.
 */
export async function findAwardById(id: string): Promise<AwardRow | null> {
  const db = getServiceRoleClient();

  const { data, error } = await db
    .from('awards')
    .select(AWARD_COLUMNS)
    .eq('id', id)
    .maybeSingle<AwardRow>();

  if (error) {
    throw error;
  }

  return data;
}

/**
 * Apply a partial update to an award and return the updated row (R18.3).
 *
 * The `WHERE` clause is scoped by both `id` and the session `familyId` as a
 * belt-and-suspenders guard on top of the service-layer ownership check, so a
 * foreign award can never be mutated here. Only keys present in `patch` are
 * written.
 *
 * @param familyId Session-derived `families.id`.
 * @param id       The award id to update.
 * @param patch    The validated, partial update body.
 */
export async function updateAward(
  familyId: string,
  id: string,
  patch: AwardUpdateInput,
): Promise<AwardRow> {
  const db = getServiceRoleClient();

  const { data, error } = await db
    .from('awards')
    .update(patch)
    .eq('id', id)
    .eq('family_id', familyId)
    .select(AWARD_COLUMNS)
    .single<AwardRow>();

  if (error) {
    throw error;
  }

  return data;
}

/**
 * Soft-delete an award: set `active = false` and RETAIN the row so historical
 * REDEMPTION references stay intact (R18.4). Returns the updated row so the
 * service can confirm the change. Scoped by `id` + `familyId` as a second guard
 * on top of the service-layer ownership check.
 *
 * @param familyId Session-derived `families.id`.
 * @param id       The award id to deactivate.
 */
export async function deactivateAward(
  familyId: string,
  id: string,
): Promise<AwardRow> {
  const db = getServiceRoleClient();

  const { data, error } = await db
    .from('awards')
    .update({ active: false })
    .eq('id', id)
    .eq('family_id', familyId)
    .select(AWARD_COLUMNS)
    .single<AwardRow>();

  if (error) {
    throw error;
  }

  return data;
}

/**
 * Match a Supabase RPC error against a named plpgsql exception.
 *
 * `redeem_award` raises `NOT_FOUND` / `INSUFFICIENT_POINTS`, which surface on
 * the Supabase error as a message containing that name (PostgreSQL
 * `raise_exception`, SQLSTATE `P0001`).
 */
function rpcErrorIs(error: PostgrestError, name: string): boolean {
  return error.message.includes(name);
}

/**
 * Invoke the atomic `redeem_award` RPC and return the created REDEMPTION ledger
 * row (R18.5/R18.6/R18.11).
 *
 * The RPC runs as one transaction: it locks the member's `family_members` row
 * (serializing concurrent redemptions so overspend is impossible — R18.11),
 * derives `points_cost` from the STORED award (never the request — R18.6),
 * computes the member's derived balance by summing the ledger (R10.1), and —
 * only when the balance covers the cost — inserts one REDEMPTION row of
 * `-points_cost` (R18.5). The caller (service) has already verified the award
 * and member belong to the session family BEFORE this is invoked.
 *
 * Raised exceptions are mapped to the shared error classes so the
 * Error_Contract reports the right code:
 *   - `INSUFFICIENT_POINTS` (the balance check failed; no row was written) →
 *     {@link InsufficientPoints} (`422`, R18.7).
 *   - `NOT_FOUND` (the award is outside the family — defensive) →
 *     {@link NotFound} (`404`, R18.10).
 *
 * @param awardId  The verified-owned award id.
 * @param memberId The redeeming member id (becomes `member_id`).
 * @param familyId Session-derived `families.id`.
 */
export async function redeemAwardRpc(
  awardId: string,
  memberId: string,
  familyId: string,
): Promise<PointsTransactionRow> {
  const db = getServiceRoleClient();

  const { data, error } = await db.rpc('redeem_award', {
    p_award_id: awardId,
    p_member_id: memberId,
    p_family_id: familyId,
  });

  if (error) {
    if (rpcErrorIs(error, 'INSUFFICIENT_POINTS')) {
      throw new InsufficientPoints();
    }
    if (rpcErrorIs(error, 'NOT_FOUND')) {
      throw new NotFound();
    }
    throw error;
  }

  return data as PointsTransactionRow;
}
