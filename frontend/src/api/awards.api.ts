/**
 * Awards domain API module (gamification write/CRUD + redemption).
 *
 * Wraps the awards portion of the backend "Gamification module" with typed
 * functions calling `client.ts`.
 *
 * Response-envelope assumptions (design "REST API Design"):
 *   GET    /family/awards     -> { awards: Award[] }   (unwrapped -> Award[])
 *   POST   /family/awards     -> 201 { award }          (unwrapped -> Award)
 *   PATCH  /awards/:id        -> { award }              (unwrapped -> Award)
 *   DELETE /awards/:id        -> 204 (active=false)      (resolves void)
 *   POST   /awards/:id/redeem -> 201 { transaction }     (unwrapped -> PointsTransaction)
 */

import { get, post, patch, del } from './client';
import type {
  Award,
  AwardCreate,
  AwardUpdate,
  Redeem,
  PointsTransaction,
} from './types';

interface AwardsEnvelope {
  awards: Award[];
}

interface AwardEnvelope {
  award: Award;
}

interface RedeemEnvelope {
  transaction: PointsTransaction;
}

/** `GET /family/awards` — all awards. Unwraps `{ awards }` → Award[]. */
export async function list(signal?: AbortSignal): Promise<Award[]> {
  const res = await get<AwardsEnvelope>('/family/awards', undefined, signal);
  return res.awards;
}

/** `POST /family/awards` — create an award. Unwraps `{ award }` → Award. */
export async function create(
  body: AwardCreate,
  signal?: AbortSignal,
): Promise<Award> {
  const res = await post<AwardEnvelope>('/family/awards', body, signal);
  return res.award;
}

/** `PATCH /awards/:id` — update an award. Unwraps `{ award }` → Award. */
export async function update(
  id: string,
  body: AwardUpdate,
  signal?: AbortSignal,
): Promise<Award> {
  const res = await patch<AwardEnvelope>(`/awards/${id}`, body, signal);
  return res.award;
}

/** `DELETE /awards/:id` — soft delete (active=false). 204 → resolves void. */
export function remove(id: string, signal?: AbortSignal): Promise<void> {
  return del<void>(`/awards/${id}`, signal);
}

/**
 * `POST /awards/:id/redeem` — redeem an award for a member, writing a
 * REDEMPTION ledger entry. Unwraps `{ transaction }` → PointsTransaction.
 */
export async function redeem(
  id: string,
  body: Redeem,
  signal?: AbortSignal,
): Promise<PointsTransaction> {
  const res = await post<RedeemEnvelope>(
    `/awards/${id}/redeem`,
    body,
    signal,
  );
  return res.transaction;
}

export const awards = {
  list,
  create,
  update,
  remove,
  redeem,
};
