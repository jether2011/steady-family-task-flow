/**
 * Dashboard & board routes — registers the aggregate home view + weekly board
 * endpoints (task 11.1).
 *
 * This is a plain registration function invoked INSIDE the encapsulated
 * `/api/v1` scope in `app.ts`, so the authentication and context `preHandler`
 * hooks already apply; paths here are relative to the `/api/v1` prefix:
 *   - `GET /family/dashboard` — the aggregate home view, returns
 *     `{ family, members, todayTasks, totals }`, family-scoped, totals summed
 *     from the ledger (R16.1–R16.3). No query params.
 *   - `GET /family/board?weekStart` — the week board, returns
 *     `{ weekStart, tasks, byDay, byStatus }`, family-scoped (R17.1/R17.3). A
 *     missing/malformed `weekStart` → `422` via the `BoardQuery` schema (R17.2).
 */
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import { boardHandler, dashboardHandler } from './dashboard.controller.js';
import {
  BoardQuery,
  BoardResponse,
  DashboardResponse,
} from './dashboard.schemas.js';

/**
 * Register the dashboard + board routes on the given (already authenticated +
 * context-resolved) Fastify scope. Call from `app.ts` inside the `/api/v1`
 * scope so the paths resolve under `/api/v1/...`.
 */
export function dashboardRoutes(app: FastifyInstance): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.route({
    method: 'GET',
    url: '/family/dashboard',
    schema: {
      response: {
        200: DashboardResponse,
      },
    },
    handler: dashboardHandler,
  });

  typed.route({
    method: 'GET',
    url: '/family/board',
    schema: {
      querystring: BoardQuery,
      response: {
        200: BoardResponse,
      },
    },
    handler: boardHandler,
  });
}
