/**
 * Dashboard & board controller — HTTP glue for the aggregate home view and the
 * weekly board (task 11.1).
 *
 * Controllers translate between HTTP and the service layer. Identity is read
 * EXCLUSIVELY from the resolved session context via `requireFamilyContext`
 * (which turns a not-yet-bootstrapped family into `404 NOT_FOUND`), never from
 * the request query, params, or headers (R16.2, R17.3, R23.2). The board
 * query has already been validated/parsed by the route's Zod schema, so a
 * missing/malformed `weekStart` (`422` — R17.2) never reaches here; the handler
 * just forwards the typed input to the service.
 *
 * Both handlers return the service's aggregate payload WHOLE (not unwrapped) to
 * match the frontend `dashboard.api` envelopes (`dashboard.get` →
 * DashboardPayload, `dashboard.board` → BoardPayload).
 */
import type { FastifyReply, FastifyRequest } from 'fastify';

import { requireFamilyContext } from '../../middleware/context.js';
import type {
  BoardPayload,
  DashboardPayload,
} from '../../shared/types/index.js';
import { board, dashboard } from './dashboard.service.js';
import type { BoardQueryInput } from './dashboard.schemas.js';

/**
 * `GET /api/v1/family/dashboard` → `{ family, members, todayTasks, totals }`
 * (R16.1). Family-scoped only (R16.2); totals summed from the ledger (R16.3).
 * Matches the frontend `dashboard.get` payload (returned whole).
 */
export async function dashboardHandler(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<DashboardPayload> {
  const { familyId, responsibleUserId } = requireFamilyContext(request);
  return dashboard({ familyId, responsibleUserId });
}

/**
 * `GET /api/v1/family/board?weekStart` → `{ weekStart, tasks, byDay, byStatus }`
 * (R17.1). `weekStart` is required and validated as an ISO date by the schema;
 * a missing/malformed value is `422` (R17.2). Family-scoped only (R17.3).
 * Matches the frontend `dashboard.board` payload (returned whole).
 */
export async function boardHandler(
  request: FastifyRequest<{ Querystring: BoardQueryInput }>,
  _reply: FastifyReply,
): Promise<BoardPayload> {
  const { familyId, responsibleUserId } = requireFamilyContext(request);
  return board({ familyId, responsibleUserId }, request.query.weekStart);
}
