/**
 * Dashboard & board domain API module.
 *
 * Wraps the backend "Dashboard & board module" with typed functions calling
 * `client.ts`.
 *
 * Response-envelope assumptions (design "REST API Design"):
 *   GET /family/dashboard -> { family, members, todayTasks, totals } (whole DashboardPayload)
 *   GET /family/board     -> { weekStart, tasks, byDay, byStatus }   (whole BoardPayload)
 *
 * Both endpoints already return purpose-built aggregate payloads, so these
 * functions return the payload whole rather than unwrapping a single key.
 */

import { get } from './client';
import type { DashboardPayload, BoardPayload } from './types';

/** `GET /family/dashboard` — the aggregate home view. */
export function getDashboard(signal?: AbortSignal): Promise<DashboardPayload> {
  return get<DashboardPayload>('/family/dashboard', undefined, signal);
}

/** `GET /family/board` — the week board, keyed by day and by status. */
export function board(
  weekStart: string,
  signal?: AbortSignal,
): Promise<BoardPayload> {
  return get<BoardPayload>('/family/board', { weekStart }, signal);
}

/**
 * Grouped export so callers can use the `dashboard.get()` / `dashboard.board()`
 * style. `getDashboard` is aliased to `get` here to avoid shadowing the
 * imported client `get`.
 */
export const dashboard = {
  get: getDashboard,
  board,
};
