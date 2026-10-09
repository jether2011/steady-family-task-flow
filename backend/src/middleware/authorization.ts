/**
 * Authorization guards — family-ownership checks for by-id resources.
 *
 * These reusable helpers enforce the ownership rule from the design
 * ("authorization.ts" + R23.3): a by-id resource may be acted on only when it
 * belongs to the session's family. A resource that is missing OR belongs to
 * another family both resolve to the SAME `404 NOT_FOUND`, so the API never
 * discloses the existence of another family's record (IDOR protection — R23.3).
 *
 * They are intentionally generic (no table/DTO coupling) so every by-id module
 * — members, tasks, templates, awards — reuses the same guard rather than
 * re-implementing the check.
 */
import { NotFound } from '../shared/errors/index.js';

/**
 * Assert that a resource's `family_id` matches the session's family.
 *
 * Call after loading a by-id resource. A `null`/`undefined` resource family id
 * (resource not found) and a mismatch (foreign family) are treated identically:
 * both throw {@link NotFound} so existence is never leaked (R23.3).
 *
 * @param resourceFamilyId The loaded resource's `family_id` (or `null` when the
 *   resource was not found).
 * @param ctxFamilyId The session family id from `request.ctx` (resolved via
 *   `requireFamilyContext`).
 * @throws NotFound when the resource is missing or belongs to another family.
 */
export function assertOwned(
  resourceFamilyId: string | null | undefined,
  ctxFamilyId: string,
): void {
  if (
    typeof resourceFamilyId !== 'string' ||
    resourceFamilyId.length === 0 ||
    resourceFamilyId !== ctxFamilyId
  ) {
    throw new NotFound();
  }
}

/** Minimal shape every family-scoped row satisfies: it carries a `family_id`. */
export interface FamilyOwned {
  readonly family_id: string;
}

/**
 * Load-and-verify helper: resolve a by-id resource, then assert family
 * ownership, returning the resource narrowed to non-null.
 *
 * `loader` typically wraps a repository `SELECT ... WHERE id = ?` returning the
 * row or `null` when absent. The guard collapses "not found" and "foreign
 * family" into a single {@link NotFound} (R23.3), so callers get back only a
 * resource they are allowed to act on.
 *
 * @example
 *   const task = await loadOwned(
 *     () => tasksRepo.findById(id),
 *     ctx.familyId,
 *   );
 *   // `task` is guaranteed to belong to ctx.familyId here.
 *
 * @param loader Returns the resource (with a `family_id`) or `null`/`undefined`.
 * @param ctxFamilyId The session family id from `request.ctx`.
 * @throws NotFound when the resource is missing or belongs to another family.
 */
export async function loadOwned<T extends FamilyOwned>(
  loader: () => Promise<T | null | undefined>,
  ctxFamilyId: string,
): Promise<T> {
  const resource = await loader();
  assertOwned(resource?.family_id, ctxFamilyId);
  // `assertOwned` has thrown unless `resource` is present and owned.
  return resource as T;
}
