/**
 * Awards service — business logic behind the awards CRUD + redemption half of
 * the gamification module (task 10.2).
 *
 * Owns the awards rules: it maps the `awards` row to the frontend
 * {@link AwardDTO} shape, and enforces family ownership for by-id operations by
 * loading the award and running {@link assertOwned}, so a foreign/missing `:id`
 * collapses to `404 NOT_FOUND` (R18.10). It holds no Supabase calls itself —
 * all persistence goes through `gamification.repository.ts`.
 *
 * Identity (`familyId`) always arrives from the caller's resolved session
 * context, never from the request body (R23.2); the controller passes it in
 * from `requireFamilyContext`.
 *
 * ### Redemption ordering (R18.9/R18.10)
 *
 * {@link redeem} enforces the error precedence the spec requires:
 *   1. Load the award + {@link assertOwned} → a foreign/missing award `:id` is
 *      `404 NOT_FOUND` (R18.10) BEFORE any member work.
 *   2. Load the `memberId` member; if it is missing or belongs to another
 *      family, that is `403 FORBIDDEN` (R18.9) — distinct from the award 404.
 *   3. Delegate to the atomic `redeem_award` RPC, which does the balance check
 *      and the REDEMPTION insert in one transaction; an insufficient balance
 *      becomes `422 INSUFFICIENT_POINTS` with no row written (R18.7/R18.11).
 */
import { assertOwned } from '../../middleware/authorization.js';
import { Forbidden } from '../../shared/errors/index.js';
import type {
  AwardDTO,
  AwardRow,
  PointsTransactionDTO,
} from '../../shared/types/index.js';
import {
  createAward,
  deactivateAward,
  findAwardById,
  findMemberById,
  listAwards,
  redeemAwardRpc,
  updateAward,
} from './gamification.repository.js';
import { toPointsTransactionDTO } from './points.service.js';
import type { AwardCreateInput, AwardUpdateInput } from './gamification.schemas.js';

/** The resolved, non-null identity an award operation needs. */
interface GamificationContext {
  familyId: string;
}

/** Map an `awards` row to the public {@link AwardDTO} (drops timestamps). */
function toAwardDTO(row: AwardRow): AwardDTO {
  return {
    id: row.id,
    family_id: row.family_id,
    title: row.title,
    description: row.description,
    points_cost: row.points_cost,
    icon: row.icon,
    color: row.color,
    active: row.active,
  };
}

/**
 * List the session family's awards (R18.1).
 *
 * @param ctx Session-derived family identity (never from the request).
 */
export async function listAwardsForFamily(
  ctx: GamificationContext,
): Promise<AwardDTO[]> {
  const rows = await listAwards(ctx.familyId);
  return rows.map(toAwardDTO);
}

/**
 * Create an award in the session family with `active` defaulting to true
 * (R18.2).
 *
 * `family_id` is taken from `ctx`, never the body (R23.2); an out-of-range
 * `title`/`points_cost` was already rejected as `422` by the Zod schema before
 * this runs.
 *
 * @param ctx  Session-derived family identity.
 * @param body The validated create body.
 */
export async function createAwardForFamily(
  ctx: GamificationContext,
  body: AwardCreateInput,
): Promise<AwardDTO> {
  const row = await createAward(ctx.familyId, body);
  return toAwardDTO(row);
}

/**
 * Update an award in the session family and return the updated record (R18.3).
 *
 * The target is first loaded and checked with {@link assertOwned}: a missing id
 * or one belonging to another family both become `404 NOT_FOUND` (R18.10). An
 * out-of-range field was already rejected as `422` by the Zod schema.
 *
 * @param ctx  Session-derived family identity.
 * @param id   The award id from the `:id` path param.
 * @param body The validated partial update body.
 */
export async function updateAwardForFamily(
  ctx: GamificationContext,
  id: string,
  body: AwardUpdateInput,
): Promise<AwardDTO> {
  const existing = await findAwardById(id);
  assertOwned(existing?.family_id, ctx.familyId);

  const row = await updateAward(ctx.familyId, id, body);
  return toAwardDTO(row);
}

/**
 * Soft-delete an award: set `active = false`, retaining the row so historical
 * REDEMPTION references remain intact (R18.4).
 *
 * The target is first loaded and checked with {@link assertOwned}, so a
 * missing/foreign id becomes `404 NOT_FOUND` (R18.10).
 *
 * @param ctx Session-derived family identity.
 * @param id  The award id from the `:id` path param.
 */
export async function deactivateAwardForFamily(
  ctx: GamificationContext,
  id: string,
): Promise<void> {
  const existing = await findAwardById(id);
  assertOwned(existing?.family_id, ctx.familyId);

  await deactivateAward(ctx.familyId, id);
}

/**
 * Redeem an award for a member, writing one REDEMPTION ledger entry of
 * `-points_cost` derived from the stored award (R18.5/R18.6).
 *
 * Error precedence (R18.9/R18.10):
 *   1. The award is loaded and checked with {@link assertOwned}; a
 *      foreign/missing award `:id` is `404 NOT_FOUND` (R18.10).
 *   2. The `memberId` member is loaded; a missing member, or one whose
 *      `family_id` differs from the award's family, is `403 FORBIDDEN` (R18.9).
 *   3. The atomic `redeem_award` RPC performs the balance check and insert in
 *      one transaction; an insufficient balance is `422 INSUFFICIENT_POINTS`
 *      with no row written (R18.7/R18.11).
 *
 * @param ctx      Session-derived family identity.
 * @param id       The award id from the `:id` path param.
 * @param memberId The redeeming member id from the request body.
 * @returns The created REDEMPTION transaction.
 */
export async function redeem(
  ctx: GamificationContext,
  id: string,
  memberId: string,
): Promise<PointsTransactionDTO> {
  const award = await findAwardById(id);
  assertOwned(award?.family_id, ctx.familyId);
  // `assertOwned` has thrown unless `award` is present and owned.
  const ownedAward = award as AwardRow;

  const member = await findMemberById(memberId);
  if (member === null || member.family_id !== ownedAward.family_id) {
    throw new Forbidden();
  }

  const transaction = await redeemAwardRpc(id, memberId, ctx.familyId);
  return toPointsTransactionDTO(transaction);
}
