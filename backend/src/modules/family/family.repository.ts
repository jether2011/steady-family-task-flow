/**
 * Family repository — the ONLY layer in this module that talks to Supabase.
 *
 * Two operations back the family module:
 *   - {@link loadFamilyAndResponsible} reads the household row and its owning
 *     responsible-user row so the service can compose the single frontend
 *     "family" DTO (R2.1).
 *   - {@link updateFamilyAtomic} routes a partial update to both tables in ONE
 *     database transaction via the `update_family` RPC (migration
 *     `006_update_family.sql`), so `name`/`avatar_url` land on `families` and
 *     `relationship`/`responsible_name`(→`name`) land on `responsible_users`
 *     all-or-nothing (R2.2).
 *
 * ### Which Supabase client
 *
 * Both reads and the write use the **service-role client**, matching the
 * `/me` bootstrap and the context resolver. Every query is keyed strictly by
 * the session-derived `familyId` / `responsibleUserId` (R2.4), so no
 * cross-family row is reachable even though RLS is bypassed. The atomic
 * two-table write additionally has to be a single transaction, which the
 * `SECURITY DEFINER` RPC provides; the user-scoped client cannot express that.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import { getServiceRoleClient } from '../../config/supabase.js';
import type { FamilyRow, ResponsibleUserRow } from '../../shared/types/index.js';
import type { FamilyUpdateInput } from './family.schemas.js';

/** Columns selected for a family row. */
const FAMILY_COLUMNS =
  'id, responsible_user_id, name, avatar_url, created_at, updated_at';

/** Columns selected for a responsible-user row. */
const RESPONSIBLE_COLUMNS =
  'id, auth_user_id, name, email, avatar_url, relationship, created_at, updated_at';

/** The household row plus its owning responsible-user row. */
export interface FamilyAndResponsible {
  family: FamilyRow;
  responsible: ResponsibleUserRow;
}

/**
 * Load the household row and the responsible-user row for a session context.
 *
 * Both rows are guaranteed to exist by the time a family-scoped route runs
 * (`requireFamilyContext` has already turned an unbootstrapped context into a
 * `404`), so a missing row here is an unexpected inconsistency and surfaces as
 * the raw Supabase error rather than a client-facing not-found.
 *
 * @param familyId          Session-derived `families.id` (R2.4).
 * @param responsibleUserId Session-derived `responsible_users.id`.
 */
export async function loadFamilyAndResponsible(
  familyId: string,
  responsibleUserId: string,
): Promise<FamilyAndResponsible> {
  const db = getServiceRoleClient();

  const familyResult = await db
    .from('families')
    .select(FAMILY_COLUMNS)
    .eq('id', familyId)
    .single<FamilyRow>();
  if (familyResult.error) {
    throw familyResult.error;
  }

  const responsibleResult = await db
    .from('responsible_users')
    .select(RESPONSIBLE_COLUMNS)
    .eq('id', responsibleUserId)
    .single<ResponsibleUserRow>();
  if (responsibleResult.error) {
    throw responsibleResult.error;
  }

  return { family: familyResult.data, responsible: responsibleResult.data };
}

/**
 * Apply a partial family update across both tables in one transaction.
 *
 * Delegates to the `update_family` RPC so the `families` write and the
 * `responsible_users` write commit or roll back together (R2.2). Each field is
 * forwarded with a `p_set_*` flag so only the keys present in the PATCH body
 * are written; absent keys leave their columns untouched. `responsible_name`
 * maps to `responsible_users.name` inside the function.
 *
 * The caller is responsible for having validated the body (invalid
 * `relationship` is already rejected as `422` by the Zod schema) and for
 * deriving `familyId`/`responsibleUserId` from the session (R2.4).
 *
 * @param familyId          Session-derived `families.id`.
 * @param responsibleUserId Session-derived `responsible_users.id`.
 * @param patch             The validated, partial update body.
 */
export async function updateFamilyAtomic(
  familyId: string,
  responsibleUserId: string,
  patch: FamilyUpdateInput,
): Promise<void> {
  const db: SupabaseClient = getServiceRoleClient();

  const { error } = await db.rpc('update_family', {
    p_family_id: familyId,
    p_responsible_user_id: responsibleUserId,
    p_set_name: patch.name !== undefined,
    p_name: patch.name ?? null,
    p_set_avatar_url: patch.avatar_url !== undefined,
    p_avatar_url: patch.avatar_url ?? null,
    p_set_relationship: patch.relationship !== undefined,
    p_relationship: patch.relationship ?? null,
    p_set_responsible_name: patch.responsible_name !== undefined,
    p_responsible_name: patch.responsible_name ?? null,
  });

  if (error) {
    throw error;
  }
}
