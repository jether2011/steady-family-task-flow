/**
 * Dashboard & board service — assembles the two read-model aggregates behind
 * `GET /family/dashboard` and `GET /family/board` (task 11.1).
 *
 * Both payloads are strictly family-scoped (R16.2, R17.3): every repository
 * read is keyed by the session-derived `familyId` the controller passes in from
 * `requireFamilyContext`, never from the request. The service holds no Supabase
 * calls itself — all persistence goes through `dashboard.repository.ts`.
 *
 * ### Dashboard (R16)
 *
 * {@link dashboard} composes `{ family, members, todayTasks, totals }`:
 *   - `family`     — the composed FamilyDTO (household row + responsible user's
 *     relationship/display name), reusing the family module's compose logic.
 *   - `members`    — the ACTIVE roster only (R16.1).
 *   - `todayTasks` — tasks whose `due_date` equals TODAY in UTC (R16.1), using
 *     the shared {@link todayIsoDate} so "today" is timezone-independent.
 *   - `totals`     — a `member_id → net points` map summed from the ENTIRE
 *     ledger (R16.3). The ledger is the single source of truth: TASK_COMPLETION
 *     / MANUAL_ADJUSTMENT add, REVERSAL / REDEMPTION subtract, so summing yields
 *     each member's current net balance. Every active member appears in the map
 *     (zero-filled when they have no ledger rows).
 *
 * ### Board (R17)
 *
 * {@link board} composes `{ weekStart, tasks, byDay, byStatus }` for the
 * requested week (`week_start == weekStart`, R17.1):
 *   - `tasks`    — the flat week slice.
 *   - `byDay`    — tasks bucketed by their `due_date` (ISO date → tasks). Tasks
 *     with a `null` due_date are omitted from `byDay` (they have no day bucket)
 *     but remain in `tasks`. This is robust to a non-Monday `weekStart`: it
 *     buckets whatever `due_date`s actually appear rather than assuming the
 *     seven canonical week dates.
 *   - `byStatus` — tasks bucketed by board column, with ALL FOUR columns always
 *     present (empty arrays when a column has no tasks), so the board can render
 *     every lane unconditionally.
 */
import { TASK_STATUS_VALUES } from '../../shared/constants/index.js';
import { todayIsoDate } from '../../shared/utils/dates.js';
import type {
  BoardPayload,
  DashboardPayload,
  FamilyDTO,
  FamilyRow,
  MemberDTO,
  FamilyMemberRow,
  PointsTransactionRow,
  ResponsibleUserRow,
  TaskDTO,
  TaskRow,
  TaskStatus,
} from '../../shared/types/index.js';
import {
  listActiveMembers,
  listAllPoints,
  listTasksByDueDate,
  listTasksByWeekStart,
  loadFamilyAndResponsible,
} from './dashboard.repository.js';

/** The resolved, non-null identity a dashboard/board read needs. */
interface DashboardContext {
  familyId: string;
  responsibleUserId: string;
}

/**
 * Compose the single frontend "family" object from the household row and the
 * responsible user's `relationship` + display name (R2.1/R16.1 DTO split).
 * Mirrors the family module's `composeFamilyDTO`.
 */
function composeFamilyDTO(
  family: FamilyRow,
  responsible: ResponsibleUserRow,
): FamilyDTO {
  return {
    id: family.id,
    name: family.name,
    avatar_url: family.avatar_url,
    relationship: responsible.relationship,
    responsible_name: responsible.name,
  };
}

/** Map a `family_members` row to the public {@link MemberDTO} (drops timestamps). */
function toMemberDTO(row: FamilyMemberRow): MemberDTO {
  return {
    id: row.id,
    family_id: row.family_id,
    name: row.name,
    member_type: row.member_type,
    avatar_url: row.avatar_url,
    color: row.color,
    birth_year: row.birth_year,
    active: row.active,
  };
}

/** Map a `tasks` row to the public {@link TaskDTO} (drops timestamps). */
function toTaskDTO(row: TaskRow): TaskDTO {
  return {
    id: row.id,
    family_id: row.family_id,
    template_id: row.template_id,
    title: row.title,
    description: row.description,
    assigned_member_id: row.assigned_member_id,
    created_by_user_id: row.created_by_user_id,
    status: row.status,
    priority: row.priority,
    points: row.points,
    due_date: row.due_date,
    due_time: row.due_time,
    week_start: row.week_start,
    carried_from_task_id: row.carried_from_task_id,
  };
}

/**
 * Sum the family's ledger into a `member_id → net points` map, zero-filled for
 * every active member (R16.3). Every row contributes its signed `points`
 * regardless of `transaction_type`, so the result is each member's current net
 * balance derived purely from the ledger.
 *
 * @param members Active roster (seeds the map so every member has a total).
 * @param rows    Every ledger row of the family.
 */
function sumTotals(
  members: FamilyMemberRow[],
  rows: PointsTransactionRow[],
): Record<string, number> {
  const totals: Record<string, number> = {};

  // Zero-fill every active member first so they all appear in the payload.
  for (const member of members) {
    totals[member.id] = 0;
  }

  for (const row of rows) {
    totals[row.member_id] = (totals[row.member_id] ?? 0) + row.points;
  }

  return totals;
}

/**
 * Assemble the dashboard aggregate for the session family (R16).
 *
 * Reads the composed family, active roster, today's tasks, and the full ledger
 * in parallel, then composes `{ family, members, todayTasks, totals }`. The
 * `now` reference is injectable so the "today" selection is deterministic in
 * tests.
 *
 * @param ctx Session-derived identity (never from the request).
 * @param now Reference instant for "today" in UTC (defaults to now).
 */
export async function dashboard(
  ctx: DashboardContext,
  now: Date = new Date(),
): Promise<DashboardPayload> {
  const today = todayIsoDate(now);

  const [{ family, responsible }, members, todayTasks, ledger] =
    await Promise.all([
      loadFamilyAndResponsible(ctx.familyId, ctx.responsibleUserId),
      listActiveMembers(ctx.familyId),
      listTasksByDueDate(ctx.familyId, today),
      listAllPoints(ctx.familyId),
    ]);

  return {
    family: composeFamilyDTO(family, responsible),
    members: members.map(toMemberDTO),
    todayTasks: todayTasks.map(toTaskDTO),
    totals: sumTotals(members, ledger),
  };
}

/** Build an empty `byStatus` map with all four board columns present. */
function emptyByStatus(): Record<TaskStatus, TaskDTO[]> {
  const byStatus = {} as Record<TaskStatus, TaskDTO[]>;
  for (const status of TASK_STATUS_VALUES) {
    byStatus[status] = [];
  }
  return byStatus;
}

/**
 * Assemble the weekly board aggregate for the session family (R17).
 *
 * Reads the week's tasks (`week_start == weekStart`, R17.1, family-scoped per
 * R17.3), then buckets them two ways: by `due_date` (`byDay`, tasks with a null
 * due_date are omitted from the day map) and by `status` (`byStatus`, all four
 * columns always present). `weekStart` has already been validated as a real
 * ISO date by the route schema (R17.2); it need not be a Monday.
 *
 * @param ctx       Session-derived identity (never from the request).
 * @param weekStart The validated `YYYY-MM-DD` week-start.
 */
export async function board(
  ctx: DashboardContext,
  weekStart: string,
): Promise<BoardPayload> {
  const rows = await listTasksByWeekStart(ctx.familyId, weekStart);
  const tasks = rows.map(toTaskDTO);

  const byDay: Record<string, TaskDTO[]> = {};
  const byStatus = emptyByStatus();

  for (const task of tasks) {
    if (task.due_date !== null) {
      const bucket = byDay[task.due_date] ?? (byDay[task.due_date] = []);
      bucket.push(task);
    }
    byStatus[task.status].push(task);
  }

  return { weekStart, tasks, byDay, byStatus };
}
