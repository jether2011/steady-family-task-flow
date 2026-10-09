/**
 * Family domain API module.
 *
 * Wraps the backend "Family module" (and the `/me` bootstrap) with typed
 * functions that call `client.ts` and unwrap the response envelope the design
 * specifies, so the TanStack Query hooks (task 17.1) can consume plain DTOs.
 *
 * Response-envelope assumptions (design "REST API Design"):
 *   GET  /me       -> { family, responsibleUser }   (returned whole as MePayload)
 *   GET  /family   -> { family }                     (unwrapped to Family)
 *   PATCH /family  -> { family }                     (unwrapped to Family)
 */

import { get, patch } from './client';
import type { Family, FamilyUpdate, MePayload } from './types';

/** Envelope wrapper used by the `/family` routes. */
interface FamilyEnvelope {
  family: Family;
}

/**
 * `GET /me` — current profile + family (the family is created on first login).
 * Returned whole because callers need both `family` and `responsibleUser`.
 *
 * Note: `/me` auth wiring lives with AuthContext (task 16.1); this helper is a
 * thin typed convenience and does not perform any session handling itself.
 */
export function me(signal?: AbortSignal): Promise<MePayload> {
  return get<MePayload>('/me', undefined, signal);
}

/** `GET /family` — the current household. Unwraps `{ family }` → Family. */
export async function getFamily(signal?: AbortSignal): Promise<Family> {
  const res = await get<FamilyEnvelope>('/family', undefined, signal);
  return res.family;
}

/** `PATCH /family` — update household fields. Unwraps `{ family }` → Family. */
export async function update(
  body: FamilyUpdate,
  signal?: AbortSignal,
): Promise<Family> {
  const res = await patch<FamilyEnvelope>('/family', body, signal);
  return res.family;
}

/**
 * Grouped export so callers can use the `family.get()` / `family.update()`
 * style described in the design. `getFamily` is aliased to `get` here to avoid
 * shadowing the imported client `get`.
 */
export const family = {
  me,
  get: getFamily,
  update,
};
