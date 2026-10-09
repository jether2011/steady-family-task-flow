/**
 * Template repository — the ONLY layer in this module that talks to Supabase.
 *
 * Backs the task-template CRUD + deactivate slice (task 9.1):
 *   - {@link listTemplates} reads the family's templates (R12.1).
 *   - {@link createTemplate} inserts a new template with `family_id` from the
 *     session and `active` defaulting to true (R12.2).
 *   - {@link findTemplateById} loads a single template for the ownership guard.
 *   - {@link updateTemplate} applies a partial update to a template (R12.3).
 *   - {@link deactivateTemplate} performs the `DELETE`-as-deactivate —
 *     `UPDATE active=false` retaining the row so historical Task references
 *     (`tasks.template_id`) stay intact (R12.4).
 *
 * ### Which Supabase client
 *
 * Every operation uses the **service-role client**, matching the members,
 * family, and tasks modules and the context resolver. All queries are keyed
 * strictly by the session-derived `familyId`, so no cross-family row is
 * reachable even though RLS is bypassed. By-id writes additionally scope the
 * `WHERE` clause by `family_id` as a second guard on top of the service-layer
 * `assertOwned` check, so a foreign/missing id can never be mutated.
 *
 * Task 9.2 (recurring generation) adds its reads here — notably an
 * active-templates query and the per-`(template_id, due_date)` existence check
 * that keeps generation idempotent.
 */
import type { TaskTemplateRow } from '../../shared/types/index.js';
import { getServiceRoleClient } from '../../config/supabase.js';
import { STATUS } from '../../shared/constants/index.js';
import type { TemplateCreateInput, TemplateUpdateInput } from './template.schemas.js';

/**
 * Postgres `unique_violation` SQLSTATE. Supabase surfaces it on the error's
 * `code` field when the partial `UNIQUE(template_id, due_date)` index (migration
 * `002`) rejects a duplicate generated task. Generation treats this as a benign
 * "already created" skip so concurrent/re-runs never error (R13.7/R13.8).
 */
const PG_UNIQUE_VIOLATION = '23505';

/** The fields describing a single generated task to insert. */
export interface GeneratedTaskInsert {
  familyId: string;
  templateId: string;
  createdByUserId: string;
  title: string;
  description: string | null;
  assignedMemberId: string | null;
  points: number;
  priority: string;
  dueDate: string;
  weekStart: string;
}

/** Columns selected for a task-template row. */
const TEMPLATE_COLUMNS =
  'id, family_id, title, description, assigned_member_id, points, priority, ' +
  'recurrence_type, recurrence_config, active, created_at, updated_at';

/**
 * List the templates of a family, always keyed by the session-derived
 * `familyId` (R12.1). Ordered by `created_at` for a stable listing.
 *
 * @param familyId Session-derived `families.id` (R12.1).
 */
export async function listTemplates(familyId: string): Promise<TaskTemplateRow[]> {
  const db = getServiceRoleClient();

  const { data, error } = await db
    .from('task_templates')
    .select(TEMPLATE_COLUMNS)
    .eq('family_id', familyId)
    .order('created_at', { ascending: true })
    .returns<TaskTemplateRow[]>();

  if (error) {
    throw error;
  }

  return data ?? [];
}

/**
 * Insert a new template into the session's family and return the created row.
 *
 * `family_id` is taken from the session, never the request (R12.2, R23.2);
 * `active` is omitted from the insert so the column default of `true` applies
 * (R12.2). `priority` and `recurrence_config` are only written when supplied so
 * the column defaults (MEDIUM / `{}`) apply when absent.
 *
 * @param familyId Session-derived `families.id` (R12.2).
 * @param input    The validated create body.
 */
export async function createTemplate(
  familyId: string,
  input: TemplateCreateInput,
): Promise<TaskTemplateRow> {
  const db = getServiceRoleClient();

  const insert: Record<string, unknown> = {
    family_id: familyId,
    title: input.title,
    description: input.description ?? null,
    assigned_member_id: input.assigned_member_id ?? null,
    points: input.points ?? 0,
    recurrence_type: input.recurrence_type,
  };

  if (input.priority !== undefined) {
    insert.priority = input.priority;
  }
  if (input.recurrence_config !== undefined) {
    insert.recurrence_config = input.recurrence_config;
  }

  const { data, error } = await db
    .from('task_templates')
    .insert(insert)
    .select(TEMPLATE_COLUMNS)
    .single<TaskTemplateRow>();

  if (error) {
    throw error;
  }

  return data;
}

/**
 * Load a single template by id, or `null` when no such row exists.
 *
 * Deliberately NOT scoped by `family_id`: the caller passes the row to
 * `assertOwned`, which collapses "not found" and "foreign family" into one
 * `404` so existence is never leaked (R12.3/R12.4).
 *
 * @param id The `task_templates.id` from the `:id` path param.
 */
export async function findTemplateById(id: string): Promise<TaskTemplateRow | null> {
  const db = getServiceRoleClient();

  const { data, error } = await db
    .from('task_templates')
    .select(TEMPLATE_COLUMNS)
    .eq('id', id)
    .maybeSingle<TaskTemplateRow>();

  if (error) {
    throw error;
  }

  return data;
}

/**
 * Apply a partial update to a template and return the updated row (R12.3).
 *
 * The `WHERE` clause is scoped by both `id` and the session `familyId` as a
 * belt-and-suspenders guard on top of the service-layer ownership check, so a
 * foreign template can never be mutated here. Only keys present in `patch` are
 * written.
 *
 * @param familyId Session-derived `families.id` (R12.3).
 * @param id       The template id to update.
 * @param patch    The validated, partial update body.
 */
export async function updateTemplate(
  familyId: string,
  id: string,
  patch: TemplateUpdateInput,
): Promise<TaskTemplateRow> {
  const db = getServiceRoleClient();

  const { data, error } = await db
    .from('task_templates')
    .update(patch)
    .eq('id', id)
    .eq('family_id', familyId)
    .select(TEMPLATE_COLUMNS)
    .single<TaskTemplateRow>();

  if (error) {
    throw error;
  }

  return data;
}

/**
 * Deactivate a template: set `active = false` and RETAIN the row so historical
 * Task references (`tasks.template_id`) stay intact (R12.4). The controller
 * answers `204`. Scoped by `id` + `familyId` as a second guard on top of the
 * service-layer ownership check, so a foreign/missing id can never be mutated.
 *
 * @param familyId Session-derived `families.id` (R12.4).
 * @param id       The template id to deactivate.
 */
export async function deactivateTemplate(familyId: string, id: string): Promise<void> {
  const db = getServiceRoleClient();

  const { error } = await db
    .from('task_templates')
    .update({ active: false })
    .eq('id', id)
    .eq('family_id', familyId);

  if (error) {
    throw error;
  }
}

/* ------------------------------------------------------------------------- *
 * Recurring generation (task 9.2)                                            *
 * ------------------------------------------------------------------------- */

/**
 * List the ACTIVE templates of a family — the set recurring generation iterates
 * over (R13.1). Keyed by the session-derived `familyId` and `active = true`
 * (matching the partial index `idx_task_templates_family_active`), so inactive
 * templates never produce tasks. Ordered by `created_at` for deterministic
 * generation order.
 *
 * @param familyId Session-derived `families.id` (R13.1).
 */
export async function listActiveTemplates(familyId: string): Promise<TaskTemplateRow[]> {
  const db = getServiceRoleClient();

  const { data, error } = await db
    .from('task_templates')
    .select(TEMPLATE_COLUMNS)
    .eq('family_id', familyId)
    .eq('active', true)
    .order('created_at', { ascending: true })
    .returns<TaskTemplateRow[]>();

  if (error) {
    throw error;
  }

  return data ?? [];
}

/**
 * Return the set of `${template_id}|${due_date}` keys for template-generated
 * tasks that ALREADY exist in the target week, so generation can skip them in
 * code rather than relying solely on the DB unique index (R13.7/R13.8).
 *
 * Reads tasks of the session family whose `week_start` equals `weekStart` and
 * whose `template_id` is not null (ad-hoc tasks have no template and never
 * collide). The returned `Set` is the "seen" set the service checks before each
 * insert and augments as it creates rows, so a single run never double-inserts
 * and a re-run creates nothing.
 *
 * @param familyId  Session-derived `families.id`.
 * @param weekStart The target week's Monday (`YYYY-MM-DD`).
 */
export async function findExistingTemplateDueKeys(
  familyId: string,
  weekStart: string,
): Promise<Set<string>> {
  const db = getServiceRoleClient();

  const { data, error } = await db
    .from('tasks')
    .select('template_id, due_date')
    .eq('family_id', familyId)
    .eq('week_start', weekStart)
    .not('template_id', 'is', null)
    .returns<{ template_id: string; due_date: string | null }[]>();

  if (error) {
    throw error;
  }

  const keys = new Set<string>();
  for (const row of data ?? []) {
    if (row.template_id !== null && row.due_date !== null) {
      keys.add(`${row.template_id}|${row.due_date}`);
    }
  }
  return keys;
}

/**
 * Insert one generated task and report whether a NEW row was created (R13.1).
 *
 * The task is written with `family_id`/`created_by_user_id` from the session
 * (R4.2, R23.2), the template's `title`/`description`/`assigned_member_id`/
 * `points`/`priority`, `status` TODO (via the column default — not set here),
 * `template_id` linking it back to its template, and `due_date`/`week_start` for
 * the target week.
 *
 * ### Idempotency backstop
 *
 * The partial `UNIQUE(template_id, due_date)` index (migration `002`) is the
 * database-level guarantee against duplicates. If a concurrent run (or a race
 * past the in-code "seen" set) tries to insert a duplicate, Postgres raises
 * `unique_violation` (`23505`); this function swallows exactly that error and
 * returns `false` ("not newly created") so generation stays idempotent and
 * never surfaces a 500 on re-run (R13.7/R13.8). Any other error propagates.
 *
 * @param insert The generated-task fields.
 * @returns `true` if a new row was inserted, `false` if it already existed.
 */
export async function insertGeneratedTask(insert: GeneratedTaskInsert): Promise<boolean> {
  const db = getServiceRoleClient();

  const { error } = await db.from('tasks').insert({
    family_id: insert.familyId,
    template_id: insert.templateId,
    created_by_user_id: insert.createdByUserId,
    title: insert.title,
    description: insert.description,
    assigned_member_id: insert.assignedMemberId,
    points: insert.points,
    priority: insert.priority,
    status: STATUS.TODO,
    due_date: insert.dueDate,
    week_start: insert.weekStart,
  });

  if (error) {
    // A duplicate (template_id, due_date) is the idempotency backstop firing —
    // treat it as an already-existing row, not a failure (R13.7/R13.8).
    if ((error as { code?: string }).code === PG_UNIQUE_VIOLATION) {
      return false;
    }
    throw error;
  }

  return true;
}
