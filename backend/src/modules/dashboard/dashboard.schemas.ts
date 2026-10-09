/**
 * Dashboard & board module Zod schemas — request/response contracts for the
 * aggregate home view and the weekly board (task 11.1).
 *
 * These schemas are attached to the routes via `fastify-type-provider-zod`, so
 * a request that fails them is rejected before any handler runs and the
 * error-handler maps the failure to `422 VALIDATION` (R17.2, R25.2).
 *
 * `GET /family/dashboard` takes NO query/body — it returns the whole
 * {@link DashboardResponse} aggregate for the session family (R16.1). Only its
 * response schema lives here.
 *
 * `GET /family/board` requires a `weekStart` query parameter validated as an
 * ISO `YYYY-MM-DD` calendar date; a missing or malformed value fails
 * {@link BoardQuery} and surfaces as `422 VALIDATION` before the service runs
 * (R17.2). `.strict()` forbids any other query key so a client-supplied
 * `familyId` (always derived from the session) is rejected rather than silently
 * ignored (R23.2).
 *
 * Both response payloads are family-scoped aggregates assembled by the service,
 * returned WHOLE (not unwrapped) to match the frontend `dashboard.api`
 * envelopes (`dashboard.get` → DashboardPayload, `dashboard.board` →
 * BoardPayload).
 */
import { z } from 'zod';

import { TASK_STATUS_VALUES } from '../../shared/constants/index.js';
import { isValidIsoDate } from '../../shared/utils/dates.js';
import { TaskDTOSchema } from '../tasks/task.schemas.js';
import { MemberDTOSchema } from '../members/member.schemas.js';
import { FamilyDTOSchema } from '../family/family.schemas.js';

/**
 * `GET /api/v1/family/board` query string: `{ weekStart }`.
 *
 * `weekStart` is REQUIRED and must be a valid ISO `YYYY-MM-DD` calendar date
 * (checked via the shared {@link isValidIsoDate} so e.g. `2024-02-30` is
 * rejected). A missing or malformed value fails here and is mapped to
 * `422 VALIDATION` by the error-handler before the service runs (R17.2). It
 * need NOT fall on a Monday — the board read buckets whatever tasks match the
 * stored `week_start`. `.strict()` forbids any other key (R23.2).
 */
export const BoardQuery = z
  .object({
    weekStart: z.string().refine(isValidIsoDate, {
      message: 'weekStart must be a valid ISO YYYY-MM-DD date',
    }),
  })
  .strict();

/** Parsed, validated `GET /family/board` query. */
export type BoardQueryInput = z.infer<typeof BoardQuery>;

/* ------------------------------------------------------------------------- *
 * Response schemas                                                           *
 * ------------------------------------------------------------------------- */

/**
 * `GET /family/dashboard` 200 envelope:
 * `{ family, members, todayTasks, totals }` (R16.1). `totals` is a map from
 * `member_id` to that member's net points summed from the ledger (R16.3).
 * Returned whole to match the frontend `dashboard.get` payload.
 */
export const DashboardResponse = z.object({
  family: FamilyDTOSchema,
  members: z.array(MemberDTOSchema),
  todayTasks: z.array(TaskDTOSchema),
  totals: z.record(z.string().uuid(), z.number().int()),
});

/**
 * `GET /family/board` 200 envelope: `{ weekStart, tasks, byDay, byStatus }`
 * (R17.1). `byDay` buckets the week's tasks by their `due_date` (ISO date →
 * tasks); `byStatus` buckets them by board column, with all four columns always
 * present. Returned whole to match the frontend `dashboard.board` payload.
 */
export const BoardResponse = z.object({
  weekStart: z.string(),
  tasks: z.array(TaskDTOSchema),
  byDay: z.record(z.string(), z.array(TaskDTOSchema)),
  byStatus: z.record(z.enum(TASK_STATUS_VALUES), z.array(TaskDTOSchema)),
});
