/**
 * Tasks module Zod schemas — request/response contracts for the task routes.
 *
 * These schemas are attached to the routes via `fastify-type-provider-zod`, so
 * a request that fails them is rejected before any handler runs and the
 * error-handler maps the failure to `422 VALIDATION` (R4.4–R4.6, R25.2).
 *
 * The create and update bodies are `.strict()`, which is the mechanism that
 * rejects a client-supplied `status`, `family_id`, or `created_by_user_id` on
 * create: those keys are never part of {@link TaskCreate}, so `.strict()`
 * fails the request as `422 VALIDATION` rather than silently accepting a value
 * that must always be derived server-side (R4.2, R23.2). `status` defaults to
 * TODO and `priority` to MEDIUM at the DB level (migration `001`), so neither
 * is accepted from the create request.
 *
 * `PATCH /tasks/:id` is a partial update and DOES allow `status` to be set to
 * any valid {BACKLOG, TODO, WORKING, DONE} value (R4.3) — this is plain field
 * validation only. Board-column moves (which forbid DONE) are a separate
 * endpoint handled in task 6.2; this schema just validates the enum.
 *
 * This file is shared by the whole tasks module: task 6.2 adds the
 * `GET /family/tasks` filter and `POST /tasks/:id/move` schemas here.
 */
import { z } from 'zod';

import { PRIORITY_VALUES, TASK_STATUS_VALUES } from '../../shared/constants/index.js';

/**
 * `POST /api/v1/family/tasks` request body.
 *
 * `title` is required and non-empty (R4.1). `priority` is constrained to the
 * enum (out-of-range → `422`, R4.5) and `points` is a non-negative integer
 * (a value below 0 → `422`, R4.6). `assigned_member_id` is validated as a uuid
 * here; whether it belongs to the family is checked in the service (not in the
 * family → `422`, R4.7). `.strict()` forbids unknown keys — crucially a
 * client-supplied `status`, `family_id`, or `created_by_user_id`, all of which
 * are server-derived (R4.2, R23.2).
 */
export const TaskCreate = z
  .object({
    title: z.string().min(1),
    description: z.string().nullable().optional(),
    assigned_member_id: z.string().uuid().nullable().optional(),
    priority: z.enum(PRIORITY_VALUES).optional(),
    points: z.number().int().min(0).optional(),
    due_date: z.string().nullable().optional(),
    due_time: z.string().nullable().optional(),
    week_start: z.string().nullable().optional(),
  })
  .strict();

/** Parsed, validated `POST /family/tasks` body. */
export type TaskCreateInput = z.infer<typeof TaskCreate>;

/**
 * `PATCH /api/v1/tasks/:id` request body.
 *
 * Every editable field is optional (a partial update, R4.3). Unlike create,
 * `status` IS allowed here and is validated against the full enum
 * {BACKLOG, TODO, WORKING, DONE} (an out-of-range value → `422`, R4.4). An
 * invalid `priority` → `422` (R4.5), `points < 0` → `422` (R4.6). `.strict()`
 * forbids unknown keys (notably `family_id`/`created_by_user_id`, always
 * server-derived — R23.2).
 */
export const TaskUpdate = z
  .object({
    title: z.string().min(1),
    description: z.string().nullable(),
    assigned_member_id: z.string().uuid().nullable(),
    priority: z.enum(PRIORITY_VALUES),
    points: z.number().int().min(0),
    due_date: z.string().nullable(),
    due_time: z.string().nullable(),
    week_start: z.string().nullable(),
    status: z.enum(TASK_STATUS_VALUES),
  })
  .partial()
  .strict();

/** Parsed, validated `PATCH /tasks/:id` body. */
export type TaskUpdateInput = z.infer<typeof TaskUpdate>;

/**
 * `:id` path parameter for the by-id routes. A non-uuid value is rejected as
 * `422 VALIDATION` before the handler runs.
 */
export const TaskIdParams = z
  .object({
    id: z.string().uuid(),
  })
  .strict();

/** Parsed, validated `:id` path params. */
export type TaskIdParamsInput = z.infer<typeof TaskIdParams>;

/** A task record returned by the task routes. */
export const TaskDTOSchema = z.object({
  id: z.string().uuid(),
  family_id: z.string().uuid(),
  template_id: z.string().uuid().nullable(),
  title: z.string(),
  description: z.string().nullable(),
  assigned_member_id: z.string().uuid().nullable(),
  created_by_user_id: z.string().uuid(),
  status: z.enum(TASK_STATUS_VALUES),
  priority: z.enum(PRIORITY_VALUES),
  points: z.number().int(),
  due_date: z.string().nullable(),
  due_time: z.string().nullable(),
  week_start: z.string().nullable(),
  carried_from_task_id: z.string().uuid().nullable(),
});

/**
 * Single-task response envelope: `{ task }`. Used for `POST` (201), `PATCH`,
 * and `POST /tasks/:id/move`. `DELETE` returns `204` with no body, so it has no
 * response schema.
 */
export const TaskResponse = z.object({
  task: TaskDTOSchema,
});

/**
 * `GET /api/v1/family/tasks` query string (task 6.2, R6.1–R6.7).
 *
 * Every filter is optional; whichever are present are applied, all scoped to
 * the session family (R6.1). A `status` outside the enum (R6.4) or a non-uuid
 * `memberId` (R6.5) / out-of-enum `priority` (R6.6) fails validation here and
 * the error-handler maps it to `422 VALIDATION` before any handler runs (R6.7).
 * `.strict()` rejects any unknown query key as `422` as well.
 *
 * `date` and `weekStart` are compared verbatim against the stored `due_date` /
 * `week_start` columns (R6.2/R6.3), so they are validated only as strings — the
 * same leniency the create/update bodies apply to those date columns.
 */
export const TaskFilter = z
  .object({
    date: z.string().optional(),
    weekStart: z.string().optional(),
    status: z.enum(TASK_STATUS_VALUES).optional(),
    memberId: z.string().uuid().optional(),
    priority: z.enum(PRIORITY_VALUES).optional(),
  })
  .strict();

/** Parsed, validated `GET /family/tasks` query string. */
export type TaskFilterInput = z.infer<typeof TaskFilter>;

/**
 * `POST /api/v1/tasks/:id/move` request body (task 6.2, R7.1–R7.3).
 *
 * The schema accepts the full {BACKLOG, TODO, WORKING, DONE} enum so a truly
 * out-of-enum value is rejected as `422 VALIDATION` by Zod (R7.3). DONE is
 * accepted by the schema on purpose: the service rejects it with a `422` whose
 * message specifically directs the caller to the completion endpoint (R7.2),
 * which is more helpful than a generic enum-rejection message. `.strict()`
 * forbids unknown keys.
 */
export const TaskMove = z
  .object({
    status: z.enum(TASK_STATUS_VALUES),
  })
  .strict();

/** Parsed, validated `POST /tasks/:id/move` body. */
export type TaskMoveInput = z.infer<typeof TaskMove>;

/** Multi-task response envelope: `{ tasks }`. Used by `GET /family/tasks`. */
export const TaskListResponse = z.object({
  tasks: z.array(TaskDTOSchema),
});

/**
 * `POST /api/v1/family/tasks/carry-over` request body (task 9.3, R14.1–R14.3).
 *
 * The carry-over target is addressed by period, matching the frontend
 * `tasks.api.carryOver` which POSTs `{ targetDate?, targetWeekStart? }`:
 *   - `targetWeekStart` carries unfinished tasks from earlier weeks onto the
 *     given `week_start`.
 *   - `targetDate` carries unfinished tasks from earlier days onto the given
 *     `due_date`.
 *
 * At least one target MUST be provided — carry-over must be explicit, so an
 * empty body is rejected as `422 VALIDATION` rather than silently defaulting to
 * "now". Both are validated as `YYYY-MM-DD` calendar-date strings (an invalid
 * format → `422`), consistent with the `GET /family/tasks` filter's string
 * comparison against the stored `due_date`/`week_start` columns. `.strict()`
 * rejects any unknown key.
 */
export const CarryOver = z
  .object({
    targetDate: z.string().date().optional(),
    targetWeekStart: z.string().date().optional(),
  })
  .strict()
  .refine(
    (v) => v.targetDate !== undefined || v.targetWeekStart !== undefined,
    { message: 'Provide targetDate or targetWeekStart' },
  );

/** Parsed, validated `POST /family/tasks/carry-over` body. */
export type CarryOverInput = z.infer<typeof CarryOver>;

/**
 * `POST /family/tasks/carry-over` response envelope: `{ created }` — the count
 * of new carried-over tasks created on this run (R14.1). Matches the frontend
 * `CarryOverResult`.
 */
export const CarryOverResult = z.object({
  created: z.number().int(),
});
