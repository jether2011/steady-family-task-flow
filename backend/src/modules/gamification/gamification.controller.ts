/**
 * Gamification controller — HTTP glue for the ledger-read + leaderboard routes
 * (task 10.1).
 *
 * Controllers translate between HTTP and the service layer. Identity is read
 * EXCLUSIVELY from the resolved session context via `requireFamilyContext`
 * (which turns a not-yet-bootstrapped family into `404 NOT_FOUND`), never from
 * the request query, params, or headers (R23.2). Query/params have already been
 * validated/parsed by each route's Zod schema, so an invalid `period` (`422` —
 * R15.5), a malformed `from`/`to` date, or a non-uuid `:id`/`memberId` never
 * reaches here; the handlers just forward the typed input to the service.
 *
 * Task 10.2 (awards CRUD + redeem) adds its award/redeem handlers here, sharing
 * the same controller surface.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';

import { requireFamilyContext } from '../../middleware/context.js';
import type {
  AwardDTO,
  LeaderboardEntry,
  PointsTransactionDTO,
} from '../../shared/types/index.js';
import {
  listTransactions,
  memberCompletions,
  type MemberCompletionsPayload,
} from './points.service.js';
import { leaderboard } from './leaderboard.service.js';
import {
  createAwardForFamily,
  deactivateAwardForFamily,
  listAwardsForFamily,
  redeem,
  updateAwardForFamily,
} from './awards.service.js';
import type {
  AwardCreateInput,
  AwardIdParamsInput,
  AwardUpdateInput,
  LeaderboardQueryInput,
  MemberCompletionsParamsInput,
  PointsQueryInput,
  RedeemInput,
} from './gamification.schemas.js';

/**
 * `GET /api/v1/family/points` → `{ transactions }` (R10.1). Family-scoped,
 * optionally filtered by `memberId`/`from`/`to`. Matches the frontend
 * `points.api.list` envelope (unwraps `{ transactions }`).
 */
export async function listPointsHandler(
  request: FastifyRequest<{ Querystring: PointsQueryInput }>,
  _reply: FastifyReply,
): Promise<{ transactions: PointsTransactionDTO[] }> {
  const { familyId } = requireFamilyContext(request);
  const transactions = await listTransactions({ familyId }, request.query);
  return { transactions };
}

/**
 * `GET /api/v1/family/leaderboard` → `{ entries }` (R15.1). `period` is required
 * and validated against {today, week, month, all} by the schema; anything else
 * is `422` (R15.5). Entries are ranked points desc, then completedTasks desc.
 * Matches the frontend `points.api.leaderboard` envelope (unwraps `{ entries }`).
 */
export async function leaderboardHandler(
  request: FastifyRequest<{ Querystring: LeaderboardQueryInput }>,
  _reply: FastifyReply,
): Promise<{ entries: LeaderboardEntry[] }> {
  const { familyId } = requireFamilyContext(request);
  const entries = await leaderboard({ familyId }, request.query.period);
  return { entries };
}

/**
 * `GET /api/v1/family/members/:id/completions` → `{ completions, transactions }`
 * (R24.3; foreign/missing member id → 404). Matches the frontend
 * `points.api.memberCompletions` payload, consumed whole.
 */
export async function memberCompletionsHandler(
  request: FastifyRequest<{ Params: MemberCompletionsParamsInput }>,
  _reply: FastifyReply,
): Promise<MemberCompletionsPayload> {
  const { familyId } = requireFamilyContext(request);
  return memberCompletions({ familyId }, request.params.id);
}

/* ------------------------------------------------------------------------- *
 * Awards CRUD + redemption (task 10.2)                                       *
 * ------------------------------------------------------------------------- */

/** `GET /api/v1/family/awards` → `{ awards }` (R18.1). Family-scoped. Matches
 * the frontend `awards.api.list` envelope (unwraps `{ awards }`). */
export async function listAwardsHandler(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<{ awards: AwardDTO[] }> {
  const { familyId } = requireFamilyContext(request);
  const awards = await listAwardsForFamily({ familyId });
  return { awards };
}

/** `POST /api/v1/family/awards` → `201 { award }` (R18.2). An out-of-range
 * `title`/`points_cost` was rejected as `422` by the schema. Matches the
 * frontend `awards.api.create` envelope. */
export async function createAwardHandler(
  request: FastifyRequest<{ Body: AwardCreateInput }>,
  reply: FastifyReply,
): Promise<{ award: AwardDTO }> {
  const { familyId } = requireFamilyContext(request);
  const award = await createAwardForFamily({ familyId }, request.body);
  void reply.code(201);
  return { award };
}

/** `PATCH /api/v1/awards/:id` → `{ award }` (R18.3; foreign/missing id → 404,
 * R18.10). Matches the frontend `awards.api.update` envelope. */
export async function updateAwardHandler(
  request: FastifyRequest<{ Params: AwardIdParamsInput; Body: AwardUpdateInput }>,
  _reply: FastifyReply,
): Promise<{ award: AwardDTO }> {
  const { familyId } = requireFamilyContext(request);
  const award = await updateAwardForFamily({ familyId }, request.params.id, request.body);
  return { award };
}

/**
 * `DELETE /api/v1/awards/:id` → `204` with no body (deactivate, R18.4;
 * foreign/missing id → 404, R18.10). Matches the frontend's
 * `awards.api.remove`, which resolves void on a 204.
 */
export async function deleteAwardHandler(
  request: FastifyRequest<{ Params: AwardIdParamsInput }>,
  reply: FastifyReply,
): Promise<void> {
  const { familyId } = requireFamilyContext(request);
  await deactivateAwardForFamily({ familyId }, request.params.id);
  void reply.code(204).send();
}

/**
 * `POST /api/v1/awards/:id/redeem` → `201 { transaction }` (R18.5).
 *
 * Error precedence enforced in the service: a foreign/missing award `:id` →
 * `404` (R18.10); a `memberId` that is missing or in another family → `403`
 * (R18.9); an insufficient balance → `422 INSUFFICIENT_POINTS` with no row
 * (R18.7). A missing/invalid `memberId` is rejected as `422 VALIDATION` by the
 * schema (R18.8). Matches the frontend `awards.api.redeem` envelope.
 */
export async function redeemAwardHandler(
  request: FastifyRequest<{ Params: AwardIdParamsInput; Body: RedeemInput }>,
  reply: FastifyReply,
): Promise<{ transaction: PointsTransactionDTO }> {
  const { familyId } = requireFamilyContext(request);
  const transaction = await redeem({ familyId }, request.params.id, request.body.memberId);
  void reply.code(201);
  return { transaction };
}
