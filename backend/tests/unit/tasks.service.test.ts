/**
 * Unit tests for the task CRUD + move service (task 6.3).
 *
 * These exercise the service's rules — assignee-in-family (R4.7), by-id
 * ownership → 404 (R5.2), the move→DONE rejection (R7.2), and the DTO mapping
 * / CRUD happy paths (R4.4–R4.6, R7.3 via the schemas) — by mocking the tasks
 * repository, so no database (or env) is involved. Schema-level validation
 * (R4.4/R4.5/R4.6/R7.3) is asserted directly against the Zod schemas with
 * `safeParse`, matching the "validation happens at the route schema" contract.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';

import { NotFound, ValidationError } from '../../src/shared/errors/index.js';
import type { TaskRow } from '../../src/shared/types/index.js';

const createTask = vi.fn<[string, string, unknown], Promise<TaskRow>>();
const findTaskById = vi.fn<[string], Promise<TaskRow | null>>();
const updateTask = vi.fn<[string, string, unknown], Promise<TaskRow>>();
const deleteTask = vi.fn<[string, string], Promise<void>>();
const moveTask = vi.fn<[string, string, string], Promise<TaskRow>>();
const memberBelongsToFamily = vi.fn<[string, string], Promise<boolean>>();

// Replace the repository so the service never touches Supabase/env. Every
// export the service barrel-imports must be present, even the carry-over ones
// unused by these tests.
vi.mock('../../src/modules/tasks/task.repository.js', () => ({
  createTask: (familyId: string, userId: string, input: unknown) =>
    createTask(familyId, userId, input),
  findTaskById: (id: string) => findTaskById(id),
  updateTask: (familyId: string, id: string, patch: unknown) =>
    updateTask(familyId, id, patch),
  deleteTask: (familyId: string, id: string) => deleteTask(familyId, id),
  moveTask: (familyId: string, id: string, status: string) =>
    moveTask(familyId, id, status),
  memberBelongsToFamily: (familyId: string, memberId: string) =>
    memberBelongsToFamily(familyId, memberId),
  // Unused by CRUD/move but imported by the service module barrel path.
  listTasks: vi.fn(),
  findCarryOverCandidates: vi.fn(),
  findAlreadyCarried: vi.fn(),
  insertCarriedTasks: vi.fn(),
}));

const { create, update, remove, move } = await import(
  '../../src/modules/tasks/task.service.js'
);
const { TaskCreate, TaskUpdate, TaskMove } = await import(
  '../../src/modules/tasks/task.schemas.js'
);

const CTX = { familyId: 'fam-1', responsibleUserId: 'user-1' };
const MEMBER_A = '11111111-1111-1111-1111-111111111111';
const TASK_ID = '22222222-2222-2222-2222-222222222222';

/** A full `tasks` row (carries the timestamps the DTO must drop). */
function taskRow(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: TASK_ID,
    family_id: 'fam-1',
    template_id: null,
    title: 'Dishes',
    description: 'After dinner',
    assigned_member_id: MEMBER_A,
    created_by_user_id: 'user-1',
    status: 'TODO',
    priority: 'MEDIUM',
    points: 5,
    due_date: '2024-01-08',
    due_time: null,
    week_start: '2024-01-08',
    carried_from_task_id: null,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-02T00:00:00Z',
    ...overrides,
  };
}

/** The DTO shape expected for {@link taskRow} (timestamps dropped). */
function expectedDTO(overrides: Partial<TaskRow> = {}) {
  const row = taskRow(overrides);
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

beforeEach(() => {
  vi.clearAllMocks();
  memberBelongsToFamily.mockResolvedValue(true);
});

// ---------------------------------------------------------------------------
// Schema validation (R4.4 / R4.5 / R4.6 / R7.3)
// ---------------------------------------------------------------------------
describe('schema validation (→ 422)', () => {
  it('TaskUpdate rejects an out-of-enum status (R4.4)', () => {
    const result = TaskUpdate.safeParse({ status: 'ARCHIVED' });
    expect(result.success).toBe(false);
  });

  it('TaskUpdate accepts every valid status (R4.4)', () => {
    for (const status of ['BACKLOG', 'TODO', 'WORKING', 'DONE']) {
      expect(TaskUpdate.safeParse({ status }).success).toBe(true);
    }
  });

  it('TaskCreate rejects an out-of-enum priority (R4.5)', () => {
    const result = TaskCreate.safeParse({ title: 'x', priority: 'SOMEDAY' });
    expect(result.success).toBe(false);
  });

  it('TaskUpdate rejects an out-of-enum priority (R4.5)', () => {
    expect(TaskUpdate.safeParse({ priority: 'SOMEDAY' }).success).toBe(false);
  });

  it('TaskCreate rejects points < 0 (R4.6)', () => {
    expect(TaskCreate.safeParse({ title: 'x', points: -1 }).success).toBe(false);
  });

  it('TaskUpdate rejects points < 0 (R4.6)', () => {
    expect(TaskUpdate.safeParse({ points: -1 }).success).toBe(false);
  });

  it('TaskCreate rejects a non-integer points value (R4.6)', () => {
    expect(TaskCreate.safeParse({ title: 'x', points: 1.5 }).success).toBe(false);
  });

  it('TaskCreate requires a non-empty title (R4.1)', () => {
    expect(TaskCreate.safeParse({ title: '' }).success).toBe(false);
  });

  it('TaskCreate rejects a client-supplied status via .strict() (R4.2)', () => {
    expect(TaskCreate.safeParse({ title: 'x', status: 'TODO' }).success).toBe(false);
  });

  it('TaskMove rejects a truly out-of-enum status (R7.3)', () => {
    expect(TaskMove.safeParse({ status: 'ARCHIVED' }).success).toBe(false);
  });

  it('TaskMove accepts the full enum including DONE — the service rejects DONE, not the schema (R7.2/R7.3)', () => {
    for (const status of ['BACKLOG', 'TODO', 'WORKING', 'DONE']) {
      expect(TaskMove.safeParse({ status }).success).toBe(true);
    }
  });

  it('property: TaskCreate rejects any negative integer points (R4.6)', () => {
    fc.assert(
      fc.property(fc.integer({ min: -1_000_000, max: -1 }), (points) => {
        return TaskCreate.safeParse({ title: 'x', points }).success === false;
      }),
    );
  });

  it('property: TaskCreate accepts any non-negative integer points (R4.6)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1_000_000 }), (points) => {
        return TaskCreate.safeParse({ title: 'x', points }).success === true;
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// move → DONE rejection (R7.2) and move happy path (R7.1)
// ---------------------------------------------------------------------------
describe('move', () => {
  it('rejects a DONE target with a ValidationError directing to the completion endpoint (R7.2)', async () => {
    await expect(move(CTX, TASK_ID, { status: 'DONE' })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(move(CTX, TASK_ID, { status: 'DONE' })).rejects.toThrow(
      /completion endpoint/i,
    );
    // Rejected before any repository read/write.
    expect(findTaskById).not.toHaveBeenCalled();
    expect(moveTask).not.toHaveBeenCalled();
  });

  it('moves to a valid non-DONE status and returns the mapped DTO (R7.1)', async () => {
    findTaskById.mockResolvedValue(taskRow());
    moveTask.mockResolvedValue(taskRow({ status: 'WORKING' }));

    const dto = await move(CTX, TASK_ID, { status: 'WORKING' });

    expect(dto).toEqual(expectedDTO({ status: 'WORKING' }));
    expect(moveTask).toHaveBeenCalledWith('fam-1', TASK_ID, 'WORKING');
  });

  it('throws NotFound when the task is missing (R5.2)', async () => {
    findTaskById.mockResolvedValue(null);

    await expect(move(CTX, TASK_ID, { status: 'WORKING' })).rejects.toBeInstanceOf(
      NotFound,
    );
    expect(moveTask).not.toHaveBeenCalled();
  });

  it('throws NotFound when the task belongs to another family (R5.2)', async () => {
    findTaskById.mockResolvedValue(taskRow({ family_id: 'other-fam' }));

    await expect(move(CTX, TASK_ID, { status: 'WORKING' })).rejects.toBeInstanceOf(
      NotFound,
    );
    expect(moveTask).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// assigned_member_id not in family (R4.7)
// ---------------------------------------------------------------------------
describe('assignee-in-family rule (R4.7)', () => {
  it('create throws ValidationError when the assignee is not in the family', async () => {
    memberBelongsToFamily.mockResolvedValue(false);

    await expect(
      create(CTX, { title: 'x', assigned_member_id: MEMBER_A }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(createTask).not.toHaveBeenCalled();
  });

  it('update throws ValidationError when the assignee is not in the family', async () => {
    findTaskById.mockResolvedValue(taskRow());
    memberBelongsToFamily.mockResolvedValue(false);

    await expect(
      update(CTX, TASK_ID, { assigned_member_id: MEMBER_A }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(updateTask).not.toHaveBeenCalled();
  });

  it('create skips the family check when no assignee is supplied', async () => {
    createTask.mockResolvedValue(taskRow({ assigned_member_id: null }));

    await create(CTX, { title: 'x' });

    expect(memberBelongsToFamily).not.toHaveBeenCalled();
    expect(createTask).toHaveBeenCalledTimes(1);
  });

  it('create skips the family check when the assignee is explicitly null', async () => {
    createTask.mockResolvedValue(taskRow({ assigned_member_id: null }));

    await create(CTX, { title: 'x', assigned_member_id: null });

    expect(memberBelongsToFamily).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Foreign / missing id → 404 (R5.2)
// ---------------------------------------------------------------------------
describe('by-id ownership → 404 (R5.2)', () => {
  it('update throws NotFound when the task is missing', async () => {
    findTaskById.mockResolvedValue(null);

    await expect(update(CTX, TASK_ID, { title: 'y' })).rejects.toBeInstanceOf(
      NotFound,
    );
    expect(updateTask).not.toHaveBeenCalled();
  });

  it('update throws NotFound when the task belongs to another family', async () => {
    findTaskById.mockResolvedValue(taskRow({ family_id: 'other-fam' }));

    await expect(update(CTX, TASK_ID, { title: 'y' })).rejects.toBeInstanceOf(
      NotFound,
    );
    expect(updateTask).not.toHaveBeenCalled();
  });

  it('remove throws NotFound when the task is missing', async () => {
    findTaskById.mockResolvedValue(null);

    await expect(remove(CTX, TASK_ID)).rejects.toBeInstanceOf(NotFound);
    expect(deleteTask).not.toHaveBeenCalled();
  });

  it('remove throws NotFound when the task belongs to another family', async () => {
    findTaskById.mockResolvedValue(taskRow({ family_id: 'other-fam' }));

    await expect(remove(CTX, TASK_ID)).rejects.toBeInstanceOf(NotFound);
    expect(deleteTask).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// CRUD happy paths (R4.4 / R4.5 / R4.6 mapping + R5.1)
// ---------------------------------------------------------------------------
describe('CRUD happy paths', () => {
  it('create returns a TaskDTO with timestamps dropped and derived identity passed to the repo', async () => {
    createTask.mockResolvedValue(taskRow());

    const dto = await create(CTX, { title: 'Dishes', assigned_member_id: MEMBER_A });

    expect(dto).toEqual(expectedDTO());
    // No created_at/updated_at leaked into the DTO.
    expect(dto).not.toHaveProperty('created_at');
    expect(dto).not.toHaveProperty('updated_at');
    // family_id + responsible user come from ctx, not the body.
    expect(createTask).toHaveBeenCalledWith('fam-1', 'user-1', {
      title: 'Dishes',
      assigned_member_id: MEMBER_A,
    });
  });

  it('update returns the mapped DTO after the ownership check', async () => {
    findTaskById.mockResolvedValue(taskRow());
    updateTask.mockResolvedValue(taskRow({ title: 'Clean room', priority: 'HIGH' }));

    const dto = await update(CTX, TASK_ID, { title: 'Clean room', priority: 'HIGH' });

    expect(dto).toEqual(expectedDTO({ title: 'Clean room', priority: 'HIGH' }));
    expect(dto).not.toHaveProperty('updated_at');
    expect(updateTask).toHaveBeenCalledWith('fam-1', TASK_ID, {
      title: 'Clean room',
      priority: 'HIGH',
    });
  });

  it('remove calls deleteTask after the ownership check passes (R5.1)', async () => {
    findTaskById.mockResolvedValue(taskRow());

    await expect(remove(CTX, TASK_ID)).resolves.toBeUndefined();

    expect(findTaskById).toHaveBeenCalledWith(TASK_ID);
    expect(deleteTask).toHaveBeenCalledWith('fam-1', TASK_ID);
  });
});
