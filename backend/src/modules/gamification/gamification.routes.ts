/**
 * Gamification routes — registers the ledger-read + leaderboard endpoints
 * (task 10.1).
 *
 * This is a plain registration function invoked INSIDE the encapsulated
 * `/api/v1` scope in `app.ts`, so the authentication and context `preHandler`
 * hooks already apply; paths here are relative to the `/api/v1` prefix:
 *   - `GET /family/points` — the family ledger, optionally filtered by
 *     `memberId`/`from`/`to`, returns `{ transactions }` (R10.1).
 *   - `GET /family/leaderboard` — ranked active-member totals for `period`,
 *     returns `{ entries }` (R15.1/R15.2). A missing/invalid `period` → `422`
 *     via the `LeaderboardQuery` schema (R15.5).
 *   - `GET /family/members/:id/completions` — one member's completions + ledger
 *     rows, returns `{ completions, transactions }`; a foreign/missing id → `404`
 *     in the service (R24.3).
 *
 * ### Extensibility for task 10.2 (awards CRUD + redeem)
 *
 * This slice registers only its three read routes but owns the module's single
 * `app.ts` wiring: `app.ts` calls `gamificationRoutes(apiV1)` once (next to
 * `templateRoutes`). Task 10.2 adds the awards endpoints —
 * `GET`/`POST /family/awards`, `PATCH`/`DELETE /awards/:id`,
 * `POST /awards/:id/redeem` — to THIS function (backed by award handlers in
 * `gamification.controller.ts`, award schemas in `gamification.schemas.ts`, an
 * awards service, and award repo functions in `gamification.repository.ts`), so
 * no further `app.ts` wiring is needed there.
 */
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import {
  createAwardHandler,
  deleteAwardHandler,
  leaderboardHandler,
  listAwardsHandler,
  listPointsHandler,
  memberCompletionsHandler,
  redeemAwardHandler,
  updateAwardHandler,
} from './gamification.controller.js';
import {
  AwardCreate,
  AwardIdParams,
  AwardResponse,
  AwardUpdate,
  AwardsResponse,
  LeaderboardQuery,
  LeaderboardResponse,
  MemberCompletionsParams,
  MemberCompletionsResponse,
  PointsListResponse,
  PointsQuery,
  Redeem,
  RedeemResponse,
} from './gamification.schemas.js';

/**
 * Register the gamification routes on the given (already authenticated +
 * context-resolved) Fastify scope. Call from `app.ts` inside the `/api/v1`
 * scope so the paths resolve under `/api/v1/...`.
 */
export function gamificationRoutes(app: FastifyInstance): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.route({
    method: 'GET',
    url: '/family/points',
    schema: {
      querystring: PointsQuery,
      response: {
        200: PointsListResponse,
      },
    },
    handler: listPointsHandler,
  });

  typed.route({
    method: 'GET',
    url: '/family/leaderboard',
    schema: {
      querystring: LeaderboardQuery,
      response: {
        200: LeaderboardResponse,
      },
    },
    handler: leaderboardHandler,
  });

  typed.route({
    method: 'GET',
    url: '/family/members/:id/completions',
    schema: {
      params: MemberCompletionsParams,
      response: {
        200: MemberCompletionsResponse,
      },
    },
    handler: memberCompletionsHandler,
  });

  // Awards CRUD + redemption (task 10.2). Collection paths live under
  // `/family/awards`; by-id paths under `/awards/:id`, matching the frontend
  // `awards.api` and the design's REST table.
  typed.route({
    method: 'GET',
    url: '/family/awards',
    schema: {
      response: {
        200: AwardsResponse,
      },
    },
    handler: listAwardsHandler,
  });

  typed.route({
    method: 'POST',
    url: '/family/awards',
    schema: {
      body: AwardCreate,
      response: {
        201: AwardResponse,
      },
    },
    handler: createAwardHandler,
  });

  typed.route({
    method: 'PATCH',
    url: '/awards/:id',
    schema: {
      params: AwardIdParams,
      body: AwardUpdate,
      response: {
        200: AwardResponse,
      },
    },
    handler: updateAwardHandler,
  });

  typed.route({
    method: 'DELETE',
    url: '/awards/:id',
    schema: {
      params: AwardIdParams,
    },
    handler: deleteAwardHandler,
  });

  typed.route({
    method: 'POST',
    url: '/awards/:id/redeem',
    schema: {
      params: AwardIdParams,
      body: Redeem,
      response: {
        201: RedeemResponse,
      },
    },
    handler: redeemAwardHandler,
  });
}
