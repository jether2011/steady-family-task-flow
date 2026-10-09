/**
 * Gamification module Zod schemas — request/response contracts for the ledger
 * reads + leaderboard (task 10.1).
 *
 * These schemas are attached to the routes via `fastify-type-provider-zod`, so
 * a request that fails them is rejected before any handler runs and the
 * error-handler maps the failure to `422 VALIDATION` (R15.5, R25.2). In
 * particular {@link LeaderboardQuery} constrains `period` to
 * {today, week, month, all}; a missing or out-of-range `period` fails
 * `z.enum(...)` and surfaces as `422` (R15.5).
 *
 * Every request schema is `.strict()`, so an unknown query key (e.g. a
 * client-supplied `familyId`, which is always derived from the session) is
 * rejected rather than silently ignored (R23.2).
 *
 * Task 10.2 (awards CRUD + redeem) adds its award body/param schemas
 * (`AwardCreate`, `AwardUpdate`, `AwardIdParams`, `Redeem`, …) to THIS file so
 * the whole gamification module shares one schema surface.
 */
import { z } from 'zod';

import {
  LEADERBOARD_PERIOD_VALUES,
  TRANSACTION_TYPE_VALUES,
} from '../../shared/constants/index.js';
import { isValidIsoDate } from '../../shared/utils/dates.js';

/**
 * `GET /api/v1/family/points` query string: `{ memberId?, from?, to? }`.
 *
 * All three are optional (the frontend `points.api.list()` drops null/undefined
 * fields). `memberId` must be a uuid when present; `from`/`to` must be valid
 * ISO `YYYY-MM-DD` calendar dates (checked via the shared {@link isValidIsoDate}
 * so e.g. `2024-02-30` is rejected). `.strict()` forbids any other key (R23.2).
 * The repository applies `from`/`to` as inclusive bounds on `created_at`.
 */
export const PointsQuery = z
  .object({
    memberId: z.string().uuid().optional(),
    from: z
      .string()
      .refine(isValidIsoDate, {
        message: 'from must be a valid ISO YYYY-MM-DD date',
      })
      .optional(),
    to: z
      .string()
      .refine(isValidIsoDate, {
        message: 'to must be a valid ISO YYYY-MM-DD date',
      })
      .optional(),
  })
  .strict();

/** Parsed, validated `GET /family/points` query. */
export type PointsQueryInput = z.infer<typeof PointsQuery>;

/**
 * `GET /api/v1/family/leaderboard` query string: `{ period }`.
 *
 * `period` is REQUIRED and constrained to {today, week, month, all}; a missing,
 * empty, or out-of-range value fails `z.enum(...)` and is mapped to
 * `422 VALIDATION` by the error-handler before the service runs (R15.5).
 * `.strict()` forbids any other key (R23.2).
 */
export const LeaderboardQuery = z
  .object({
    period: z.enum(LEADERBOARD_PERIOD_VALUES),
  })
  .strict();

/** Parsed, validated `GET /family/leaderboard` query. */
export type LeaderboardQueryInput = z.infer<typeof LeaderboardQuery>;

/**
 * `:id` path parameter for `GET /family/members/:id/completions`. A non-uuid
 * value is rejected as `422 VALIDATION` before the handler runs; a well-formed
 * but foreign/missing id resolves to `404` in the service (`assertOwned`).
 */
export const MemberCompletionsParams = z
  .object({
    id: z.string().uuid(),
  })
  .strict();

/** Parsed, validated member-completions `:id` path params. */
export type MemberCompletionsParamsInput = z.infer<typeof MemberCompletionsParams>;

/* ------------------------------------------------------------------------- *
 * Response schemas                                                           *
 * ------------------------------------------------------------------------- */

/** A points-ledger entry as serialized by the gamification routes. */
export const PointsTransactionDTOSchema = z.object({
  id: z.string().uuid(),
  family_id: z.string().uuid(),
  member_id: z.string().uuid(),
  task_id: z.string().uuid().nullable(),
  points: z.number().int(),
  transaction_type: z.enum(TRANSACTION_TYPE_VALUES),
  created_at: z.string(),
});

/** A task-completion row as serialized by the member-completions route. */
export const TaskCompletionDTOSchema = z.object({
  id: z.string().uuid(),
  task_id: z.string().uuid(),
  family_id: z.string().uuid(),
  completed_by_user_id: z.string().uuid(),
  completed_by_member_id: z.string().uuid(),
  completed_at: z.string(),
});

/** One leaderboard entry: `{ memberId, name, color, points, completedTasks }`. */
export const LeaderboardEntrySchema = z.object({
  memberId: z.string().uuid(),
  name: z.string(),
  color: z.string().nullable(),
  points: z.number().int(),
  completedTasks: z.number().int().min(0),
});

/** `GET /family/points` 200 envelope: `{ transactions }` (R10.1). */
export const PointsListResponse = z.object({
  transactions: z.array(PointsTransactionDTOSchema),
});

/** `GET /family/leaderboard` 200 envelope: `{ entries }` (R15.1). */
export const LeaderboardResponse = z.object({
  entries: z.array(LeaderboardEntrySchema),
});

/**
 * `GET /family/members/:id/completions` 200 envelope:
 * `{ completions, transactions }` — the MemberProfile payload the frontend
 * `points.memberCompletions` consumes whole.
 */
export const MemberCompletionsResponse = z.object({
  completions: z.array(TaskCompletionDTOSchema),
  transactions: z.array(PointsTransactionDTOSchema),
});

/* ------------------------------------------------------------------------- *
 * Awards CRUD + redemption (task 10.2)                                       *
 * ------------------------------------------------------------------------- */

/** Minimum / maximum `points_cost` an award may carry (R18.2). */
const POINTS_COST_MIN = 0;
const POINTS_COST_MAX = 999999;

/**
 * `POST /api/v1/family/awards` request body (R18.2).
 *
 * `title` is 1–200 characters; `points_cost` is an integer in the range
 * 0–999999 (both bounds inclusive) — any value outside these fails validation
 * and surfaces as `422 VALIDATION`. `description`, `icon`, and `color` are
 * optional. `.strict()` forbids unknown keys — crucially a client-supplied
 * `family_id` or `active`, both server-derived (R23.2); `active` defaults to
 * true on create in the repository.
 */
export const AwardCreate = z
  .object({
    title: z.string().min(1).max(200),
    points_cost: z.number().int().min(POINTS_COST_MIN).max(POINTS_COST_MAX),
    description: z.string().nullable().optional(),
    icon: z.string().optional(),
    color: z.string().nullable().optional(),
  })
  .strict();

/** Parsed, validated `POST /family/awards` body. */
export type AwardCreateInput = z.infer<typeof AwardCreate>;

/**
 * `PATCH /api/v1/awards/:id` request body (R18.3).
 *
 * Every field is optional (a partial update) and `active` may be toggled
 * directly. The same bounds apply as on create: `title` 1–200, `points_cost`
 * an integer 0–999999 (out-of-range → `422`). `.strict()` forbids unknown keys
 * (notably `family_id`, always session-derived — R23.2).
 */
export const AwardUpdate = z
  .object({
    title: z.string().min(1).max(200),
    points_cost: z.number().int().min(POINTS_COST_MIN).max(POINTS_COST_MAX),
    description: z.string().nullable(),
    icon: z.string(),
    color: z.string().nullable(),
    active: z.boolean(),
  })
  .partial()
  .strict();

/** Parsed, validated `PATCH /awards/:id` body. */
export type AwardUpdateInput = z.infer<typeof AwardUpdate>;

/**
 * `:id` path parameter for the by-id award routes (`PATCH`/`DELETE`/`redeem`).
 * A non-uuid value is rejected as `422 VALIDATION` before the handler runs; a
 * well-formed but foreign/missing id resolves to `404` in the service via
 * `assertOwned` (R18.10).
 */
export const AwardIdParams = z
  .object({
    id: z.string().uuid(),
  })
  .strict();

/** Parsed, validated award `:id` path params. */
export type AwardIdParamsInput = z.infer<typeof AwardIdParams>;

/**
 * `POST /api/v1/awards/:id/redeem` request body: `{ memberId }` (R18.5/R18.8).
 *
 * `memberId` is REQUIRED and must be a uuid; a missing or malformed value fails
 * validation and surfaces as `422 VALIDATION` (R18.8). `.strict()` forbids any
 * other key — notably a client-supplied `points_cost`, which is always derived
 * from the stored award (R18.6).
 */
export const Redeem = z
  .object({
    memberId: z.string().uuid(),
  })
  .strict();

/** Parsed, validated `POST /awards/:id/redeem` body. */
export type RedeemInput = z.infer<typeof Redeem>;

/** An award record as serialized by the awards routes. */
export const AwardDTOSchema = z.object({
  id: z.string().uuid(),
  family_id: z.string().uuid(),
  title: z.string(),
  description: z.string().nullable(),
  points_cost: z.number().int(),
  icon: z.string(),
  color: z.string().nullable(),
  active: z.boolean(),
});

/** `GET /family/awards` 200 envelope: `{ awards: Award[] }` (R18.1). */
export const AwardsResponse = z.object({
  awards: z.array(AwardDTOSchema),
});

/**
 * Single-award response envelope: `{ award }`. Used for `POST` (201) and
 * `PATCH` (200). Matches the frontend `awards.api` create/update envelopes.
 */
export const AwardResponse = z.object({
  award: AwardDTOSchema,
});

/**
 * `POST /awards/:id/redeem` 201 envelope: `{ transaction }` — the created
 * REDEMPTION ledger entry (R18.5). Matches the frontend `awards.api.redeem`
 * envelope, which unwraps `{ transaction }`.
 */
export const RedeemResponse = z.object({
  transaction: PointsTransactionDTOSchema,
});
