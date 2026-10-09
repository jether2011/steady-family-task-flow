/**
 * Template service — business logic behind the template routes (CRUD slice,
 * task 9.1).
 *
 * Owns the task-template list/create/update/deactivate rules: it maps a
 * `task_templates` row to the frontend {@link TemplateDTO} shape and enforces
 * family ownership for by-id operations by loading the row and running
 * {@link assertOwned} (foreign/missing `:id` → `404 NOT_FOUND`, R12.3/R12.4).
 * It holds no Supabase calls itself — all persistence goes through
 * `template.repository.ts`.
 *
 * Identity (`familyId`) always arrives from the caller's resolved session
 * context, never from the request body (R23.2); the controller passes it in
 * from `requireFamilyContext`. The CUSTOM `recurrence_config.days` rule (R12.5)
 * is enforced upstream by the Zod schema's `superRefine`, so by the time a body
 * reaches this service it already satisfies the recurrence contract.
 *
 * Task 9.2 (recurring generation) adds its `generate` logic here, delegating
 * weekday math to the shared UTC date utils and the per-date task inserts to a
 * generation service/repository.
 */
import { assertOwned } from '../../middleware/authorization.js';
import type {
  RecurrenceType,
  TaskTemplateRow,
  TemplateDTO,
} from '../../shared/types/index.js';
import { utcWeekday, weekDates } from '../../shared/utils/dates.js';
import {
  createTemplate,
  deactivateTemplate,
  findExistingTemplateDueKeys,
  findTemplateById,
  insertGeneratedTask,
  listActiveTemplates,
  listTemplates,
  updateTemplate,
} from './template.repository.js';
import type { TemplateCreateInput, TemplateUpdateInput } from './template.schemas.js';

/** The resolved, non-null identity a template operation needs. */
interface TemplateContext {
  familyId: string;
}

/** The identity a generation run needs: family + the responsible user id. */
interface GenerateContext {
  familyId: string;
  responsibleUserId: string;
}

/** Map a `task_templates` row to the public {@link TemplateDTO} (drops timestamps). */
function toTemplateDTO(row: TaskTemplateRow): TemplateDTO {
  return {
    id: row.id,
    family_id: row.family_id,
    title: row.title,
    description: row.description,
    assigned_member_id: row.assigned_member_id,
    points: row.points,
    priority: row.priority,
    recurrence_type: row.recurrence_type,
    recurrence_config: row.recurrence_config ?? {},
    active: row.active,
  };
}

/**
 * List the session family's templates (R12.1). Every result is strictly
 * family-scoped.
 *
 * @param ctx Session-derived identity.
 */
export async function list(ctx: TemplateContext): Promise<TemplateDTO[]> {
  const rows = await listTemplates(ctx.familyId);
  return rows.map(toTemplateDTO);
}

/**
 * Create a template in the session family with `active` defaulting to true
 * (R12.2).
 *
 * `family_id` is taken from `ctx`, never the body (R23.2); a client-supplied
 * `family_id`/`active` was already rejected as `422` by the schema's
 * `.strict()`. An invalid `recurrence_type`/`priority`/`points`, or a CUSTOM
 * template missing a valid `recurrence_config.days`, was already rejected as
 * `422` by Zod (R12.2/R12.5).
 *
 * @param ctx  Session-derived identity.
 * @param body The validated create body.
 */
export async function create(
  ctx: TemplateContext,
  body: TemplateCreateInput,
): Promise<TemplateDTO> {
  const row = await createTemplate(ctx.familyId, body);
  return toTemplateDTO(row);
}

/**
 * Update a template in the session family and return the updated record
 * (R12.3).
 *
 * The target is first loaded and checked with {@link assertOwned}: a missing id
 * or one belonging to another family both become `404 NOT_FOUND`. Invalid field
 * values, or a patch setting `recurrence_type` to CUSTOM without a valid
 * `recurrence_config.days`, were already rejected as `422` by Zod (R12.5).
 *
 * @param ctx  Session-derived identity.
 * @param id   The template id from the `:id` path param.
 * @param body The validated partial update body.
 */
export async function update(
  ctx: TemplateContext,
  id: string,
  body: TemplateUpdateInput,
): Promise<TemplateDTO> {
  const existing = await findTemplateById(id);
  assertOwned(existing?.family_id, ctx.familyId);

  const row = await updateTemplate(ctx.familyId, id, body);
  return toTemplateDTO(row);
}

/**
 * Deactivate a template in the session family (R12.4). The controller answers
 * `204`.
 *
 * The target is first loaded and checked with {@link assertOwned}, so a
 * missing/foreign id becomes `404 NOT_FOUND`. The row is retained with
 * `active = false` so historical Task references stay intact.
 *
 * @param ctx Session-derived identity.
 * @param id  The template id from the `:id` path param.
 */
export async function deactivate(ctx: TemplateContext, id: string): Promise<void> {
  const existing = await findTemplateById(id);
  assertOwned(existing?.family_id, ctx.familyId);

  await deactivateTemplate(ctx.familyId, id);
}

/* ------------------------------------------------------------------------- *
 * Recurring generation (task 9.2)                                            *
 * ------------------------------------------------------------------------- */

/** Monday–Friday weekday numbers under the 0 = Sunday … 6 = Saturday scheme. */
const MONDAY = 1;
const FRIDAY = 5;

/**
 * Decide whether a template produces a task on a date with the given UTC
 * weekday number, per the template's recurrence rule (R13.2–R13.6). This is a
 * faithful UTC port of the original Base44 `generateRecurring` branching:
 *
 *   - `DAILY`    → every day of the week (R13.2).
 *   - `WEEKDAYS` → Monday through Friday only (weekday 1..5, R13.3).
 *   - `WEEKLY`   → Monday only (weekday 1, R13.4).
 *   - `CUSTOM`   → only when the weekday number appears in
 *                  `recurrence_config.days` (0..6, R13.5).
 *
 * The weekday is always computed in UTC by the caller (via {@link utcWeekday}),
 * so evaluation is timezone-independent (R13.6).
 *
 * @param recurrenceType The template's recurrence rule.
 * @param days           `recurrence_config.days` for CUSTOM templates (else unused).
 * @param weekday        The date's UTC weekday number (0 = Sunday … 6 = Saturday).
 */
function shouldGenerate(
  recurrenceType: RecurrenceType,
  days: number[] | undefined,
  weekday: number,
): boolean {
  switch (recurrenceType) {
    case 'DAILY':
      return true;
    case 'WEEKDAYS':
      return weekday >= MONDAY && weekday <= FRIDAY;
    case 'WEEKLY':
      return weekday === MONDAY;
    case 'CUSTOM':
      return Array.isArray(days) && days.includes(weekday);
    default:
      return false;
  }
}

/**
 * Materialize recurring tasks for a target week, idempotently (R13).
 *
 * For every ACTIVE template, for each of the seven UTC dates of `weekStart`'s
 * week, {@link shouldGenerate} decides whether a task is due. A due task is
 * created only if no `(template_id, due_date)` row already exists; existing rows
 * are skipped and NOT counted toward `created` (R13.7). The "already exists"
 * check is a `Set` seeded from the DB (`findExistingTemplateDueKeys`) and
 * augmented after each successful insert, so a single run never double-inserts
 * and a re-run of an unchanged week returns `created: 0` with the same final
 * task set (R13.8). The partial `UNIQUE(template_id, due_date)` index is the
 * database backstop: an insert that races past the seen set is swallowed by the
 * repository and also counts as "not created".
 *
 * `weekStart` has already been validated as a UTC Monday by the `Generate`
 * schema, so a missing/malformed/non-Monday value was rejected as `422` before
 * this runs and no task was created (R13.9).
 *
 * @param ctx       Session-derived family id + responsible user id (R4.2, R23.2).
 * @param weekStart The target week's Monday (`YYYY-MM-DD`), already validated.
 * @returns `{ weekStart, created }` where `created` counts only new tasks.
 */
export async function generate(
  ctx: GenerateContext,
  weekStart: string,
): Promise<{ weekStart: string; created: number }> {
  const templates = await listActiveTemplates(ctx.familyId);
  const seen = await findExistingTemplateDueKeys(ctx.familyId, weekStart);
  const dates = weekDates(weekStart);

  let created = 0;

  for (const template of templates) {
    const days = template.recurrence_config?.days;
    for (const dueDate of dates) {
      if (!shouldGenerate(template.recurrence_type, days, utcWeekday(dueDate))) {
        continue;
      }

      const key = `${template.id}|${dueDate}`;
      if (seen.has(key)) {
        continue;
      }

      const inserted = await insertGeneratedTask({
        familyId: ctx.familyId,
        templateId: template.id,
        createdByUserId: ctx.responsibleUserId,
        title: template.title,
        description: template.description,
        assignedMemberId: template.assigned_member_id,
        points: template.points,
        priority: template.priority,
        dueDate,
        weekStart,
      });

      // Mark the key seen regardless so a within-run duplicate is never retried.
      seen.add(key);
      if (inserted) {
        created += 1;
      }
    }
  }

  return { weekStart, created };
}
