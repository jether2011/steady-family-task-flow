/**
 * Member repository — the ONLY layer in this module that talks to Supabase.
 *
 * Backs the members CRUD + soft-delete:
 *   - {@link listMembers} reads the family roster, optionally filtered to the
 *     active members (R3.1).
 *   - {@link createMember} inserts a new member with `family_id` from the
 *     session and `active` defaulting to true (R3.2).
 *   - {@link findMemberById} loads a single member for the ownership guard.
 *   - {@link updateMember} applies a partial update to a member (R3.3).
 *   - {@link deactivateMember} performs the soft delete — `UPDATE active=false`
 *     retaining the row so historical references stay intact (R3.4).
 *
 * ### Which Supabase client
 *
 * Every operation uses the **service-role client**, matching the family module
 * and the context resolver. All queries are keyed strictly by the
 * session-derived `familyId` (R3.6), so no cross-family row is reachable even
 * though RLS is bypassed. By-id writes additionally scope the `WHERE` clause by
 * `family_id` as a second guard on top of the service-layer `assertOwned`
 * check, so a foreign/missing id can never be mutated.
 */
import type { FamilyMemberRow } from '../../shared/types/index.js';
import { getServiceRoleClient } from '../../config/supabase.js';
import type { MemberCreateInput, MemberUpdateInput } from './member.schemas.js';

/** Columns selected for a family member row. */
const MEMBER_COLUMNS =
  'id, family_id, name, member_type, avatar_url, color, birth_year, active, created_at, updated_at';

/**
 * List the members of a family, optionally restricted to the active roster.
 *
 * Always keyed by the session-derived `familyId` (R3.6). When `activeOnly` is
 * true only members with `active = true` are returned (the frontend's
 * `members.api.list(true)` filter); otherwise every member is returned (R3.1).
 *
 * @param familyId   Session-derived `families.id` (R3.6).
 * @param activeOnly When true, return only `active = true` members.
 */
export async function listMembers(
  familyId: string,
  activeOnly: boolean,
): Promise<FamilyMemberRow[]> {
  const db = getServiceRoleClient();

  let query = db
    .from('family_members')
    .select(MEMBER_COLUMNS)
    .eq('family_id', familyId);

  if (activeOnly) {
    query = query.eq('active', true);
  }

  const { data, error } = await query
    .order('created_at', { ascending: true })
    .returns<FamilyMemberRow[]>();

  if (error) {
    throw error;
  }

  return data ?? [];
}

/**
 * Insert a new member into the session's family.
 *
 * `family_id` is taken from the session context, never the request (R3.2,
 * R23.2); `active` is omitted from the insert so the column default of `true`
 * applies (R3.2). The inserted row is selected back so the service can return
 * the created member.
 *
 * @param familyId Session-derived `families.id` (R3.2).
 * @param input    The validated create body.
 */
export async function createMember(
  familyId: string,
  input: MemberCreateInput,
): Promise<FamilyMemberRow> {
  const db = getServiceRoleClient();

  const { data, error } = await db
    .from('family_members')
    .insert({
      family_id: familyId,
      name: input.name,
      member_type: input.member_type,
      avatar_url: input.avatar_url ?? null,
      color: input.color ?? null,
      birth_year: input.birth_year ?? null,
    })
    .select(MEMBER_COLUMNS)
    .single<FamilyMemberRow>();

  if (error) {
    throw error;
  }

  return data;
}

/**
 * Load a single member by id, or `null` when no such row exists.
 *
 * Deliberately NOT scoped by `family_id`: the caller passes the row to
 * `assertOwned`, which collapses "not found" and "foreign family" into one
 * `404` so existence is never leaked (R3.6).
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

/**
 * Apply a partial update to a member and return the updated row (R3.3).
 *
 * The `WHERE` clause is scoped by both `id` and the session `familyId` as a
 * belt-and-suspenders guard on top of the service-layer ownership check, so a
 * foreign member can never be mutated here. Only keys present in `patch` are
 * written.
 *
 * @param familyId Session-derived `families.id` (R3.6).
 * @param id       The member id to update.
 * @param patch    The validated, partial update body.
 */
export async function updateMember(
  familyId: string,
  id: string,
  patch: MemberUpdateInput,
): Promise<FamilyMemberRow> {
  const db = getServiceRoleClient();

  const { data, error } = await db
    .from('family_members')
    .update(patch)
    .eq('id', id)
    .eq('family_id', familyId)
    .select(MEMBER_COLUMNS)
    .single<FamilyMemberRow>();

  if (error) {
    throw error;
  }

  return data;
}

/**
 * Soft-delete a member: set `active = false` and RETAIN the row so historical
 * Task_Completion and Points_Ledger references stay intact (R3.4). Returns the
 * updated row (with `active = false`) so the route can echo `{ member }` back,
 * matching the frontend's `members.api.remove`.
 *
 * Scoped by `id` + `familyId` as a second guard on top of the service-layer
 * ownership check.
 *
 * @param familyId Session-derived `families.id` (R3.6).
 * @param id       The member id to deactivate.
 */
export async function deactivateMember(
  familyId: string,
  id: string,
): Promise<FamilyMemberRow> {
  const db = getServiceRoleClient();

  const { data, error } = await db
    .from('family_members')
    .update({ active: false })
    .eq('id', id)
    .eq('family_id', familyId)
    .select(MEMBER_COLUMNS)
    .single<FamilyMemberRow>();

  if (error) {
    throw error;
  }

  return data;
}
