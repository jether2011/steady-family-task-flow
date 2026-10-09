/**
 * Completions module Zod schemas — request/response contracts for the
 * completion route (task 7.1).
 *
 * These schemas are attached to the route via `fastify-type-provider-zod`, so a
 * request that fails them is rejected before the handler runs and the
 * error-handler maps the failure to `422 VALIDATION` (R8.5, R25.2).
 *
 * The body is `.strict()`: `completedByMemberId` is the ONLY accepted key.
 * `points`, `family_id`, `completed_by_user_id`, and the completion timestamp
 * are all server-derived and MUST NOT be accepted from the client (R23.6) — any
 * extra key fails `.strict()` as `422`. A missing or empty/non-uuid
 * `completedByMemberId` also fails here as `422` (R8.5).
 */
import { z } from 'zod';

import {
  PRIORITY_VALUES,
  TASK_STATUS_VALUES,
} from '../../shared/constants/index.js';

/**
 * `:id` path parameter for `POST /tasks/:id/complete`. A non-uuid value is
 * rejected as `422 VALIDATION` before the handler runs.
 */
export const CompleteIdParams = z
  .object({
    id: z.string().uuid(),
  })
  .strict();

/** Parsed, validated `:id` path params. */
export type CompleteIdParamsInput = z.infer<typeof CompleteIdParams>;

/**
 * `POST /api/v1/tasks/:id/complete` request body.
 *
 * `completedByMemberId` is required and must be a uuid; a missing/empty value
 * fails validation as `422` (R8.5). `.strict()` rejects any other key so the
 * client can never smuggle in `points`, `family_id`, or `completed_by_user_id`
 * (all server-derived — R23.6).
 */
export const TaskComplete = z
  .object({
    completedByMemberId: z.string().uuid(),
  })
  .strict();

/** Parsed, validated `POST /tasks/:id/complete` body. */
export type TaskCompleteInput = z.infer<typeof TaskComplete>;

/**
 * `POST /tasks/:id/complete` response envelope (R8.2):
 * `{ task:{ id, status:'DONE', completedAt }, completion:{ completedByMemberId },
 * points:{ awarded } }`. Shaped exactly to match the `CompleteTaskPayload` DTO
 * and the frontend `tasks.api.complete` expectation.
 */
export const CompleteTaskResponse = z.object({
  task: z.object({
    id: z.string().uuid(),
    status: z.literal(TASK_STATUS_VALUES[3]), // 'DONE'
    completedAt: z.string(),
  }),
  completion: z.object({
    completedByMemberId: z.string().uuid(),
  }),
  points: z.object({
    awarded: z.number().int(),
  }),
});

/**
 * `:id` path parameter for `POST /tasks/:id/reopen`. A non-uuid value is
 * rejected as `422 VALIDATION` before the handler runs. (Separate alias from
 * {@link CompleteIdParams} so each route documents its own param clearly; the
 * shape is identical.)
 */
export const ReopenIdParams = z
  .object({
    id: z.string().uuid(),
  })
  .strict();

/** Parsed, validated `:id` path params for reopen. */
export type ReopenIdParamsInput = z.infer<typeof ReopenIdParams>;

/**
 * Full task DTO shape returned by the reopen route — mirrors the tasks module's
 * `TaskDTOSchema` so the reopened `Task` serializes identically to every other
 * task payload the frontend consumes.
 */
const ReopenTaskDTOSchema = z.object({
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
 * `POST /tasks/:id/reopen` response envelope (R11.1):
 * `{ task, reversedPoints }`. `task` is the FULL updated task (status back to
 * `TODO`); `reversedPoints` is a non-negative integer (0 when the original
 * award was 0 — R11.5). Matches the frontend `ReopenTaskPayload` exactly.
 */
export const ReopenResponse = z.object({
  task: ReopenTaskDTOSchema,
  reversedPoints: z.number().int().min(0),
});
