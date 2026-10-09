/**
 * Task-templates module Zod schemas — request/response contracts for the
 * template routes (CRUD slice, task 9.1).
 *
 * These schemas are attached to the routes via `fastify-type-provider-zod`, so
 * a request that fails them is rejected before any handler runs and the
 * error-handler maps the failure to `422 VALIDATION` (R12.5, R25.2).
 *
 * The create and update bodies are `.strict()`, which rejects a client-supplied
 * `family_id` or `active` on create: those keys are never part of
 * {@link TemplateCreate}, so `.strict()` fails the request as `422 VALIDATION`
 * rather than silently accepting a value that must always be derived
 * server-side (R23.2). `active` defaults to `true` at the DB level (migration
 * `001`), so it is not accepted from the create request.
 *
 * ### CUSTOM recurrence rule (R12.5)
 *
 * A `recurrence_type` of CUSTOM requires `recurrence_config.days` to be a
 * non-empty array of integers in the range 0–6; anything else is rejected as
 * `422 VALIDATION`. The weekday-range (0..6 int) is validated structurally by
 * {@link RecurrenceConfigSchema}; the "CUSTOM requires a non-empty days array"
 * cross-field rule is enforced by the `superRefine` on both the create and
 * update bodies.
 *
 * This file is shared by the whole templates module: task 9.2 adds the
 * `POST /family/task-templates/generate` body schema (`{ weekStart }`) here.
 */
import { z } from 'zod';

import { PRIORITY_VALUES, RECURRENCE_TYPE_VALUES } from '../../shared/constants/index.js';
import { isUtcMonday } from '../../shared/utils/dates.js';

/**
 * `recurrence_config` jsonb payload. `days` is an array of weekday numbers,
 * each a 0..6 integer (0 = Sunday … 6 = Saturday). A value outside that range
 * (or a non-integer) fails here and surfaces as `422` (R12.5). Whether a
 * non-empty `days` array is REQUIRED is decided per `recurrence_type` by the
 * body-level `superRefine`.
 */
export const RecurrenceConfigSchema = z
  .object({
    days: z.array(z.number().int().min(0).max(6)),
  })
  .strict();

/**
 * Cross-field CUSTOM rule shared by create and update (R12.5).
 *
 * When the effective `recurrence_type` is CUSTOM, `recurrence_config.days` must
 * be present and non-empty; otherwise an issue is raised on
 * `recurrence_config.days` so the request fails as `422 VALIDATION`. Any other
 * `recurrence_type` imposes no requirement on `recurrence_config`.
 */
function refineCustomDays(value: unknown, ctx: z.RefinementCtx): void {
  const v = value as {
    recurrence_type?: string;
    recurrence_config?: { days?: number[] };
  };
  if (v.recurrence_type !== 'CUSTOM') {
    return;
  }
  const days = v.recurrence_config?.days;
  if (!Array.isArray(days) || days.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        'recurrence_type CUSTOM requires recurrence_config.days to be a non-empty array of integers in 0..6',
      path: ['recurrence_config', 'days'],
    });
  }
}

/**
 * `POST /api/v1/family/task-templates` request body.
 *
 * `title` is required and non-empty (R12.2). `recurrence_type` is constrained
 * to the enum {DAILY, WEEKDAYS, WEEKLY, CUSTOM} (out-of-range → `422`, R12.2).
 * `priority` is constrained to the enum and `points` is a non-negative integer
 * (either out-of-range → `422`). `assigned_member_id` is validated as a uuid
 * here. `recurrence_config` is optional and structurally validated by
 * {@link RecurrenceConfigSchema}. `.strict()` forbids unknown keys — notably a
 * client-supplied `family_id` or `active`, both server-derived (R23.2). The
 * `superRefine` enforces the CUSTOM days rule (R12.5).
 */
export const TemplateCreate = z
  .object({
    title: z.string().min(1),
    description: z.string().nullable().optional(),
    assigned_member_id: z.string().uuid().nullable().optional(),
    points: z.number().int().min(0).optional(),
    priority: z.enum(PRIORITY_VALUES).optional(),
    recurrence_type: z.enum(RECURRENCE_TYPE_VALUES),
    recurrence_config: RecurrenceConfigSchema.optional(),
  })
  .strict()
  .superRefine(refineCustomDays);

/** Parsed, validated `POST /family/task-templates` body. */
export type TemplateCreateInput = z.infer<typeof TemplateCreate>;

/**
 * `PATCH /api/v1/task-templates/:id` request body.
 *
 * Every editable field is optional (a partial update, R12.3) and `active` may
 * be toggled directly. An invalid `recurrence_type`/`priority` → `422`; a
 * `points < 0` → `422`. `.strict()` forbids unknown keys (notably `family_id`,
 * always server-derived — R23.2).
 *
 * The `superRefine` applies the same CUSTOM rule as create, but only when it is
 * decidable from the patch: if the patch sets `recurrence_type` to CUSTOM it
 * must also carry a non-empty `recurrence_config.days` (R12.5). A patch that
 * touches neither field is unconstrained here.
 */
export const TemplateUpdate = z
  .object({
    title: z.string().min(1),
    description: z.string().nullable(),
    assigned_member_id: z.string().uuid().nullable(),
    points: z.number().int().min(0),
    priority: z.enum(PRIORITY_VALUES),
    recurrence_type: z.enum(RECURRENCE_TYPE_VALUES),
    recurrence_config: RecurrenceConfigSchema,
    active: z.boolean(),
  })
  .partial()
  .strict()
  .superRefine(refineCustomDays);

/** Parsed, validated `PATCH /task-templates/:id` body. */
export type TemplateUpdateInput = z.infer<typeof TemplateUpdate>;

/**
 * `:id` path parameter for the by-id routes. A non-uuid value is rejected as
 * `422 VALIDATION` before the handler runs.
 */
export const TemplateIdParams = z
  .object({
    id: z.string().uuid(),
  })
  .strict();

/** Parsed, validated `:id` path params. */
export type TemplateIdParamsInput = z.infer<typeof TemplateIdParams>;

/** A template record returned by the template routes. */
export const TemplateDTOSchema = z.object({
  id: z.string().uuid(),
  family_id: z.string().uuid(),
  title: z.string(),
  description: z.string().nullable(),
  assigned_member_id: z.string().uuid().nullable(),
  points: z.number().int(),
  priority: z.enum(PRIORITY_VALUES),
  recurrence_type: z.enum(RECURRENCE_TYPE_VALUES),
  recurrence_config: z.object({ days: z.array(z.number().int()).optional() }),
  active: z.boolean(),
});

/**
 * Single-template response envelope: `{ template }`. Used for `POST` (201) and
 * `PATCH`. `DELETE` returns `204` with no body (deactivate), so it has no
 * response schema.
 */
export const TemplateResponse = z.object({
  template: TemplateDTOSchema,
});

/** `GET /family/task-templates` 200 envelope: `{ templates }`. */
export const TemplateListResponse = z.object({
  templates: z.array(TemplateDTOSchema),
});

/**
 * `POST /api/v1/family/task-templates/generate` request body: `{ weekStart }`.
 *
 * `weekStart` must be a string that is a valid ISO-8601 calendar date in
 * `YYYY-MM-DD` form AND falls on a Monday in UTC. A missing, non-string,
 * malformed, or non-Monday `weekStart` fails here and is mapped to
 * `422 VALIDATION` by the error-handler BEFORE the generate service runs, so no
 * Task is ever created for an invalid week (R13.9). The Monday/ISO check is
 * expressed as a Zod `refine` over the shared UTC {@link isUtcMonday} helper so
 * validation happens up front at the schema boundary rather than mid-service.
 * `.strict()` rejects any extra key.
 */
export const Generate = z
  .object({
    weekStart: z
      .string()
      .refine(isUtcMonday, {
        message: 'weekStart must be a valid ISO YYYY-MM-DD date that falls on a Monday (UTC)',
      }),
  })
  .strict();

/** Parsed, validated `POST /family/task-templates/generate` body. */
export type GenerateInput = z.infer<typeof Generate>;

/**
 * `POST /family/task-templates/generate` 200 envelope: `{ weekStart, created }`.
 *
 * `created` is the integer count of Tasks created by THIS invocation; tasks
 * skipped because a `(template_id, due_date)` row already existed are not
 * counted, so a re-run of an unchanged week returns `created: 0` (R13.7/R13.8).
 * Matches the frontend `templates.api.generate` result shape (task 15.2).
 */
export const GenerateResult = z.object({
  weekStart: z.string(),
  created: z.number().int().min(0),
});
