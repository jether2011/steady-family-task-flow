/**
 * Member service — business logic behind `/api/v1/family/members`.
 *
 * Owns the members CRUD + soft-delete rules: it maps the `family_members` row
 * to the frontend {@link MemberDTO} shape, and enforces family ownership for
 * by-id operations by loading the row and running {@link assertOwned}, so a
 * foreign/missing `:id` collapses to `404 NOT_FOUND` (R3.6). It holds no
 * Supabase calls itself — all persistence goes through `member.repository.ts`.
 *
 * Identity (`familyId`) always arrives from the caller's resolved session
 * context, never from the request body (R3.2, R23.2); the controller passes it
 * in from `requireFamilyContext`.
 */
import { assertOwned } from '../../middleware/authorization.js';
import type { FamilyMemberRow, MemberDTO } from '../../shared/types/index.js';
import {
  createMember,
  deactivateMember,
  findMemberById,
  listMembers,
  updateMember,
} from './member.repository.js';
import type { MemberCreateInput, MemberUpdateInput } from './member.schemas.js';

/** The resolved, non-null identity a member operation needs. */
interface MemberContext {
  familyId: string;
}

/** Map a `family_members` row to the public {@link MemberDTO} (drops timestamps). */
function toMemberDTO(row: FamilyMemberRow): MemberDTO {
  return {
    id: row.id,
    family_id: row.family_id,
    name: row.name,
    member_type: row.member_type,
    avatar_url: row.avatar_url,
    color: row.color,
    birth_year: row.birth_year,
    active: row.active,
  };
}

/**
 * List the session family's members (R3.1).
 *
 * @param ctx     Session-derived family identity (never from the request).
 * @param options `activeOnly` restricts the roster to active members.
 */
export async function list(
  ctx: MemberContext,
  options: { activeOnly?: boolean } = {},
): Promise<MemberDTO[]> {
  const rows = await listMembers(ctx.familyId, options.activeOnly === true);
  return rows.map(toMemberDTO);
}

/**
 * Create a member in the session family with `active` defaulting to true (R3.2).
 *
 * `family_id` is taken from `ctx`, never the body (R3.2, R23.2); an invalid
 * `member_type` was already rejected as `422` by the Zod schema before this
 * runs (R3.5).
 *
 * @param ctx  Session-derived family identity.
 * @param body The validated create body.
 */
export async function create(
  ctx: MemberContext,
  body: MemberCreateInput,
): Promise<MemberDTO> {
  const row = await createMember(ctx.familyId, body);
  return toMemberDTO(row);
}

/**
 * Update a member in the session family and return the updated record (R3.3).
 *
 * The target is first loaded and checked with {@link assertOwned}: a missing id
 * or one belonging to another family both become `404 NOT_FOUND` (R3.6). An
 * invalid `member_type` was already rejected as `422` by the Zod schema (R3.5).
 *
 * @param ctx  Session-derived family identity.
 * @param id   The member id from the `:id` path param.
 * @param body The validated partial update body.
 */
export async function update(
  ctx: MemberContext,
  id: string,
  body: MemberUpdateInput,
): Promise<MemberDTO> {
  const existing = await findMemberById(id);
  assertOwned(existing?.family_id, ctx.familyId);

  const row = await updateMember(ctx.familyId, id, body);
  return toMemberDTO(row);
}

/**
 * Soft-delete a member: set `active = false`, retaining the row so historical
 * references remain intact, and return the updated record (R3.4).
 *
 * The target is first loaded and checked with {@link assertOwned}, so a
 * missing/foreign id becomes `404 NOT_FOUND` (R3.6).
 *
 * @param ctx Session-derived family identity.
 * @param id  The member id from the `:id` path param.
 */
export async function deactivate(
  ctx: MemberContext,
  id: string,
): Promise<MemberDTO> {
  const existing = await findMemberById(id);
  assertOwned(existing?.family_id, ctx.familyId);

  const row = await deactivateMember(ctx.familyId, id);
  return toMemberDTO(row);
}
