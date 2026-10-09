/**
 * Property-based test for the carry-over service (task 9.5).
 *
 * **Property 8: Carry-over is idempotent and linked** — for any set of eligible
 * unfinished prior-period origin tasks and a target period, a first
 * `carryOver()` run creates exactly one new task per origin, each linked to its
 * origin (`carried_from_task_id == origin.id`), reset to TODO, scoped to the
 * session `family_id`/`created_by_user_id` from `ctx`, and placed in the target
 * period; `created` equals the number of eligible origins. A second run for the
 * SAME target — now that the already-carried set reflects the first run's
 * inserts — creates nothing (`created == 0`) and leaves the carried set
 * unchanged.
 *
 * **Validates: Requirements 14.1, 14.2, 14.3**
 *
 * The service (`carryOver(ctx, body)`) depends on three repository calls, so we
 * mock `task.repository.js` and back those three with a faithful, stateful
 * in-memory model of the family's tasks:
 *   - `findCarryOverCandidates` → the generated eligible origins (the real
 *     query's `< target` lower bound means the just-created carried tasks, which
 *     sit IN the target period, are never re-selected — so candidates stay the
 *     same across runs).
 *   - `findAlreadyCarried` → the set of origin ids that already have a carried
 *     copy in the target, derived from the in-memory created list (matching the
 *     real `carried_from_task_id IN originIds AND period == target` query).
 *   - `insertCarriedTasks` → append the rows (materialized as TaskRows) and
 *     return them.
 * The remaining named exports are inert stubs so the module barrel resolves.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';

import type { TaskRow } from '../../src/shared/types/index.js';
import type {
  CarriedTaskInsert,
  CarryOverTarget,
} from '../../src/modules/tasks/task.repository.js';
import { PRIORITY_VALUES } from '../../src/shared/constants/index.js';

// In-memory store of carried tasks created across a single scenario run. The
// mocks below read/write this so idempotency (R14.3) is exercised end-to-end.
let carried: TaskRow[] = [];
let insertSeq = 0;

const findCarryOverCandidates =
  vi.fn<[string, CarryOverTarget], Promise<TaskRow[]>>();

/**
 * Faithful model of the real `findAlreadyCarried`: of the given origin ids,
 * return those that already have a carried copy whose own period matches the
 * target (week_start == targetWeekStart | due_date == targetDate).
 */
async function findAlreadyCarriedModel(
  _familyId: string,
  target: CarryOverTarget,
  originIds: string[],
): Promise<Set<string>> {
  const ids = new Set(originIds);
  const seen = new Set<string>();
  for (const row of carried) {
    if (row.carried_from_task_id === null) continue;
    if (!ids.has(row.carried_from_task_id)) continue;
    const periodMatches =
      target.kind === 'week'
        ? row.week_start === target.targetWeekStart
        : row.due_date === target.targetDate;
    if (periodMatches) {
      seen.add(row.carried_from_task_id);
    }
  }
  return seen;
}

/**
 * Faithful model of the real `insertCarriedTasks`: materialize each insert
 * payload into a TaskRow (as the DB would, filling id/timestamps/defaults),
 * append it to the in-memory store, and return the created rows.
 */
async function insertCarriedTasksModel(
  rows: CarriedTaskInsert[],
): Promise<TaskRow[]> {
  const created = rows.map((r) => {
    insertSeq += 1;
    const row: TaskRow = {
      id: `carried-${insertSeq}`,
      family_id: r.family_id,
      template_id: null,
      title: r.title,
      description: r.description,
      assigned_member_id: r.assigned_member_id,
      created_by_user_id: r.created_by_user_id,
      status: r.status,
      priority: r.priority,
      points: r.points,
      due_date: r.due_date,
      due_time: null,
      week_start: r.week_start,
      carried_from_task_id: r.carried_from_task_id,
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-01T00:00:00Z',
    };
    return row;
  });
  carried.push(...created);
  return created;
}

const findAlreadyCarried =
  vi.fn<
    [string, CarryOverTarget, string[]],
    Promise<Set<string>>
  >(findAlreadyCarriedModel);
const insertCarriedTasks =
  vi.fn<[CarriedTaskInsert[]], Promise<TaskRow[]>>(insertCarriedTasksModel);

// Replace the repository so the service never touches Supabase/env.
vi.mock('../../src/modules/tasks/task.repository.js', () => ({
  findCarryOverCandidates: (familyId: string, target: CarryOverTarget) =>
    findCarryOverCandidates(familyId, target),
  findAlreadyCarried: (
    familyId: string,
    target: CarryOverTarget,
    originIds: string[],
  ) => findAlreadyCarried(familyId, target, originIds),
  insertCarriedTasks: (rows: CarriedTaskInsert[]) => insertCarriedTasks(rows),
  // Unused by carryOver() but imported via the module barrel path.
  createTask: vi.fn(),
  deleteTask: vi.fn(),
  findTaskById: vi.fn(),
  listTasks: vi.fn(),
  memberBelongsToFamily: vi.fn(),
  moveTask: vi.fn(),
  updateTask: vi.fn(),
}));

const { carryOver } = await import(
  '../../src/modules/tasks/task.service.js'
);

const CTX = { familyId: 'fam-1', responsibleUserId: 'user-1' };

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks resets implementations too; restore the stateful models.
  findAlreadyCarried.mockImplementation(findAlreadyCarriedModel);
  insertCarriedTasks.mockImplementation(insertCarriedTasksModel);
  carried = [];
  insertSeq = 0;
});

/** A generated eligible origin task (unfinished, from a prior period). */
function origin(
  id: string,
  title: string,
  points: number,
  priority: TaskRow['priority'],
  assignedMemberId: string | null,
): TaskRow {
  return {
    id,
    family_id: CTX.familyId,
    template_id: null,
    title,
    description: null,
    assigned_member_id: assignedMemberId,
    created_by_user_id: 'someone-else',
    // Non-DONE: eligible. The repository filters DONE out, so candidates are
    // always unfinished by construction.
    status: 'WORKING',
    priority,
    points,
    // Prior-period values; the service overwrites these on the carried copy.
    due_date: '2023-12-01',
    due_time: '09:00',
    week_start: '2023-11-27',
    carried_from_task_id: null,
    created_at: '2023-12-01T00:00:00Z',
    updated_at: '2023-12-01T00:00:00Z',
  };
}

interface Scenario {
  origins: TaskRow[];
  target: CarryOverTarget;
}

/** Generator: a distinct set of eligible origins + a week- or date-mode target. */
const scenarioArb: fc.Arbitrary<Scenario> = fc
  .uniqueArray(
    fc.record({
      id: fc.string({ minLength: 1, maxLength: 10 }),
      title: fc.string({ minLength: 1, maxLength: 24 }),
      points: fc.integer({ min: 0, max: 500 }),
      priority: fc.constantFrom<TaskRow['priority']>(...PRIORITY_VALUES),
      assignedMemberId: fc.option(fc.string({ minLength: 1, maxLength: 8 }), {
        nil: null,
      }),
    }),
    { selector: (o) => o.id, minLength: 0, maxLength: 8 },
  )
  .chain((raw) => {
    const origins = raw.map((o) =>
      origin(o.id, o.title, o.points, o.priority, o.assignedMemberId),
    );
    const target: fc.Arbitrary<CarryOverTarget> = fc.oneof(
      fc.constant<CarryOverTarget>({ kind: 'week', targetWeekStart: '2024-01-08' }),
      fc.constant<CarryOverTarget>({ kind: 'date', targetDate: '2024-01-10' }),
    );
    return fc.record({ origins: fc.constant(origins), target });
  });

/** Build the carry-over request body for a resolved target. */
function bodyFor(target: CarryOverTarget) {
  return target.kind === 'week'
    ? { targetWeekStart: target.targetWeekStart }
    : { targetDate: target.targetDate };
}

describe('Feature: family-task-board-backend, Property 8: Carry-over is idempotent and linked', () => {
  it('first run links one carried task per origin; a re-run for the same target creates nothing', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (scenario) => {
        // Fresh state per generated case (beforeEach only runs once per `it`).
        carried = [];
        insertSeq = 0;
        findCarryOverCandidates.mockResolvedValue(scenario.origins);

        const { target } = scenario;
        const expectedDueDate =
          target.kind === 'date' ? target.targetDate : null;
        const expectedWeekStart =
          target.kind === 'week' ? target.targetWeekStart : null;

        // ---- First run: linked + complete (R14.1, R14.2). ----
        const first = await carryOver(CTX, bodyFor(target));

        // One carried task per eligible origin; count matches.
        expect(first.created).toBe(scenario.origins.length);
        expect(carried).toHaveLength(scenario.origins.length);

        // Every origin is linked exactly once, with the right shape.
        const byOrigin = new Map(
          carried.map((c) => [c.carried_from_task_id, c]),
        );
        for (const o of scenario.origins) {
          const copy = byOrigin.get(o.id);
          expect(copy).toBeDefined();
          if (!copy) continue;
          // R14.2: linked to its origin.
          expect(copy.carried_from_task_id).toBe(o.id);
          // Reset to TODO regardless of the origin's board column.
          expect(copy.status).toBe('TODO');
          // Identity derived from ctx, never the origin/body (R14.2, R23.2).
          expect(copy.family_id).toBe(CTX.familyId);
          expect(copy.created_by_user_id).toBe(CTX.responsibleUserId);
          // Origin content is copied through.
          expect(copy.title).toBe(o.title);
          expect(copy.points).toBe(o.points);
          expect(copy.priority).toBe(o.priority);
          expect(copy.assigned_member_id).toBe(o.assigned_member_id);
          // Placed in the target period, not the origin's prior period (R14.1).
          expect(copy.due_date).toBe(expectedDueDate);
          expect(copy.week_start).toBe(expectedWeekStart);
        }

        // Exactly one carried copy per distinct origin (no duplicates).
        expect(byOrigin.size).toBe(scenario.origins.length);

        // Snapshot the carried set to prove the re-run leaves it unchanged.
        const afterFirst = carried.map((c) => c.id).sort();

        // ---- Second run for the SAME target: idempotent no-op (R14.3). ----
        const second = await carryOver(CTX, bodyFor(target));

        expect(second.created).toBe(0);
        expect(carried).toHaveLength(scenario.origins.length);
        expect(carried.map((c) => c.id).sort()).toEqual(afterFirst);
      }),
      { numRuns: 200 },
    );
  });
});
