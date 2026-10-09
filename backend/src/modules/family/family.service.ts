/**
 * Family service — business logic behind `GET`/`PATCH /api/v1/family`.
 *
 * The service owns the single-object illusion the frontend relies on: it
 * composes the one "family" DTO from the two backing rows on read (R2.1) and
 * routes a flat partial update back to the correct tables on write (R2.2). It
 * holds no Supabase calls itself — all persistence goes through
 * `family.repository.ts`.
 *
 * Identity (`familyId`, `responsibleUserId`) always arrives from the caller's
 * resolved session context, never from the request body (R2.4); the controller
 * passes it in from `requireFamilyContext`.
 */
import type { FamilyDTO, FamilyRow, ResponsibleUserRow } from '../../shared/types/index.js';
import {
  loadFamilyAndResponsible,
  updateFamilyAtomic,
} from './family.repository.js';
import type { FamilyUpdateInput } from './family.schemas.js';

/** The resolved, non-null identity a family-scoped operation needs. */
interface FamilyContext {
  familyId: string;
  responsibleUserId: string;
}

/**
 * Compose the single frontend "family" object from the household row and the
 * responsible user's `relationship` + display name (R2.1/R2.2 DTO split).
 */
function composeFamilyDTO(
  family: FamilyRow,
  responsible: ResponsibleUserRow,
): FamilyDTO {
  return {
    id: family.id,
    name: family.name,
    avatar_url: family.avatar_url,
    relationship: responsible.relationship,
    responsible_name: responsible.name,
  };
}

/**
 * Return the composed family DTO for the session's family (R2.1).
 *
 * @param ctx Session-derived family identity (never from the request).
 */
export async function getFamily(ctx: FamilyContext): Promise<FamilyDTO> {
  const { family, responsible } = await loadFamilyAndResponsible(
    ctx.familyId,
    ctx.responsibleUserId,
  );
  return composeFamilyDTO(family, responsible);
}

/**
 * Apply a validated partial update to the session's family and return the
 * freshly composed DTO (R2.2).
 *
 * The write routes `name`/`avatar_url` to `families` and
 * `relationship`/`responsible_name`(→`name`) to `responsible_users` in one
 * transaction (repository RPC). The DTO is then re-read so the response always
 * reflects persisted state. `family_id` is taken from `ctx`, never the body
 * (R2.4); an invalid `relationship` was already rejected as `422` by the Zod
 * schema before this runs (R2.3).
 *
 * @param ctx   Session-derived family identity.
 * @param patch The validated, partial update body.
 */
export async function updateFamily(
  ctx: FamilyContext,
  patch: FamilyUpdateInput,
): Promise<FamilyDTO> {
  await updateFamilyAtomic(ctx.familyId, ctx.responsibleUserId, patch);
  return getFamily(ctx);
}
