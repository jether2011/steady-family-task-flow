/**
 * Unit tests for the completion service (task 7.3, optional).
 *
 * Feature: family-task-board-backend
 * Validates: Requirements 8.2, 8.3, 8.4, 8.6, 8.7, 9.2, 11.4.
 *
 * ----------------------------------------------------------------------------
 * What this covers
 * ----------------------------------------------------------------------------
 * The completion SERVICE enforces the precise Error_Contract codes IN CODE,
 * BEFORE the atomic RPC runs, so the API returns 403 / 422 / 404 / 409
 * distinctly instead of collapsing everything into the RPC's generic
 * exceptions. Those pre-RPC checks are pure logic over the two repository reads
 * (`findTaskById`, `findMemberById`), so they are exercised here with the
 * repository fully mocked — no database, no env — keeping the default
 * `npm test` green without a Postgres (the atomic RPC behaviour itself is
 * covered by the DB-backed suites, including completion-reopen.test.ts).
 *
 * `complete` assertions:
 *   - inactive member            → ValidationError (422 VALIDATION, R8.6)
 *   - member in another family   → Forbidden      (403 FORBIDDEN,   R8.7)
 *   - foreign / missing task     → NotFound        (404 NOT_FOUND,  R8.8)
 *   - already-DONE task          → Conflict        (409,            R9.2)
 *   - success payload shape      → { task:{id,status:'DONE',completedAt},
 *                                     completion:{completedByMemberId},
 *                                     points:{awarded} }               (R8.2)
 *     with completed_by_user_id = the session responsible user (R8.3) and
 *     completed_by_member_id = the supplied member (R8.4): the service passes
 *     the responsible user + member into the RPC and surfaces the RPC's derived
 *     result in the payload.
 *
 * `reopen` assertions:
 *   - non-DONE task              → ValidationError (422 VALIDATION, R11.4)
 *   - foreign / missing task     → NotFound        (404 NOT_FOUND,  R11.8)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  FamilyMemberRow,
  TaskRow,
} from '../../src/shared/types/index.js';
import type {
  CompleteTaskRpcResult,
  ReopenTaskRpcResult,
} from '../../src/modules/completions/completion.repository.js';
import {
  Conflict,
  Forbidden,
  NotFound,
  ValidationError,
} from '../../src/shared/errors/index.js';

// --- repository mock --------------------------------------------------------
// The service's ONLY dependency that touches Supabase is the repository, so we
// replace it wholesale. Each fn is a spy configured per test.
const findTaskById = vi.fn<[string], Promise<TaskRow | null>>();
const findMemberById = vi.fn<[string], Promise<FamilyMemberRow | null>>();
const completeTaskRpc =
  vi.fn<[string, string, string], Promise<CompleteTaskRpcResult>>();
const reopenTaskRpc = vi.fn<[string], Promise<ReopenTaskRpcResult>>();

vi.mock('../../src/modules/completions/completion.repository.js', () => ({
  findTaskById: (id: string) => findTaskById(id),
  findMemberById: (id: string) => findMemberById(id),
  completeTaskRpc: (taskId: string, memberId: string, responsibleUserId: string) =>
    completeTaskRpc(taskId, memberId, responsibleUserId),
  reopenTaskRpc: (taskId: string) => reopenTaskRpc(taskId),
}));

const { complete, reopen } = await import(
  '../../src/modules/completions/completion.service.js'
);

// --- fixtures ---------------------------------------------------------------
const FAMILY_ID = '11111111-1111-1111-1111-111111111111';
const OTHER_FAMILY_ID = '22222222-2222-2222-2222-222222222222';
const RESPONSIBLE_USER_ID = '33333333-3333-3333-3333-333333333333';
const TASK_ID = '44444444-4444-4444-4444-444444444444';
const MEMBER_ID = '55555555-5555-5555-5555-555555555555';

const CTX = { familyId: FAMILY_ID, responsibleUserId: RESPONSIBLE_USER_ID };

function task(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: TASK_ID,
    family_id: FAMILY_ID,
    template_id: null,
    title: 'A chore',
    description: null,
    assigned_member_id: MEMBER_ID,
    created_by_user_id: RESPONSIBLE_USER_ID,
    status: 'TODO',
    priority: 'MEDIUM',
    points: 10,
    due_date: null,
    due_time: null,
    week_start: null,
    carried_from_task_id: null,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

function member(overrides: Partial<FamilyMemberRow> = {}): FamilyMemberRow {
  return {
    id: MEMBER_ID,
    family_id: FAMILY_ID,
    name: 'Kid',
    member_type: 'CHILD',
    avatar_url: null,
    color: null,
    birth_year: null,
    active: true,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('complete — ordered checks surface precise error codes', () => {
  it('inactive member → 422 VALIDATION (R8.6)', async () => {
    findTaskById.mockResolvedValue(task());
    findMemberById.mockResolvedValue(member({ active: false }));

    await expect(
      complete(CTX, TASK_ID, { completedByMemberId: MEMBER_ID }),
    ).rejects.toBeInstanceOf(ValidationError);

    // No RPC runs when a pre-check fails — nothing is written.
    expect(completeTaskRpc).not.toHaveBeenCalled();
  });

  it('member belongs to another family → 403 FORBIDDEN (R8.7)', async () => {
    findTaskById.mockResolvedValue(task());
    findMemberById.mockResolvedValue(member({ family_id: OTHER_FAMILY_ID }));

    await expect(
      complete(CTX, TASK_ID, { completedByMemberId: MEMBER_ID }),
    ).rejects.toBeInstanceOf(Forbidden);
    expect(completeTaskRpc).not.toHaveBeenCalled();
  });

  it('nonexistent member → 403 FORBIDDEN (R8.7)', async () => {
    findTaskById.mockResolvedValue(task());
    findMemberById.mockResolvedValue(null);

    await expect(
      complete(CTX, TASK_ID, { completedByMemberId: MEMBER_ID }),
    ).rejects.toBeInstanceOf(Forbidden);
    expect(completeTaskRpc).not.toHaveBeenCalled();
  });

  it('foreign task (different family) → 404 NOT_FOUND (R8.8)', async () => {
    findTaskById.mockResolvedValue(task({ family_id: OTHER_FAMILY_ID }));

    await expect(
      complete(CTX, TASK_ID, { completedByMemberId: MEMBER_ID }),
    ).rejects.toBeInstanceOf(NotFound);
    // Ownership fails before the member is ever loaded.
    expect(findMemberById).not.toHaveBeenCalled();
    expect(completeTaskRpc).not.toHaveBeenCalled();
  });

  it('missing task → 404 NOT_FOUND (R8.8)', async () => {
    findTaskById.mockResolvedValue(null);

    await expect(
      complete(CTX, TASK_ID, { completedByMemberId: MEMBER_ID }),
    ).rejects.toBeInstanceOf(NotFound);
    expect(completeTaskRpc).not.toHaveBeenCalled();
  });

  it('already-DONE task → 409 TASK_ALREADY_COMPLETED (R9.2)', async () => {
    findTaskById.mockResolvedValue(task({ status: 'DONE' }));
    findMemberById.mockResolvedValue(member());

    await expect(
      complete(CTX, TASK_ID, { completedByMemberId: MEMBER_ID }),
    ).rejects.toBeInstanceOf(Conflict);
    // The 409 fast path short-circuits before the RPC.
    expect(completeTaskRpc).not.toHaveBeenCalled();
  });

  it('shapes the 201 payload from the RPC result and credits the right actor + member (R8.2/R8.3/R8.4)', async () => {
    findTaskById.mockResolvedValue(task({ points: 10 }));
    findMemberById.mockResolvedValue(member());
    completeTaskRpc.mockResolvedValue({
      status: 'DONE',
      completedAt: '2024-02-02T12:00:00Z',
      completedByMemberId: MEMBER_ID,
      awarded: 10,
    });

    const payload = await complete(CTX, TASK_ID, {
      completedByMemberId: MEMBER_ID,
    });

    // The exact envelope the frontend expects (R8.2).
    expect(payload).toEqual({
      task: {
        id: TASK_ID,
        status: 'DONE',
        completedAt: '2024-02-02T12:00:00Z',
      },
      completion: {
        completedByMemberId: MEMBER_ID,
      },
      points: {
        awarded: 10,
      },
    });

    // The actor is the SESSION responsible user (R8.3) and the credited member
    // is the supplied one (R8.4) — the service passes both into the RPC, never
    // reading identity from the body.
    expect(completeTaskRpc).toHaveBeenCalledWith(
      TASK_ID,
      MEMBER_ID,
      RESPONSIBLE_USER_ID,
    );
  });

  it('surfaces the RPC-derived award (0) rather than the stored task points (R8.2)', async () => {
    findTaskById.mockResolvedValue(task({ points: 0 }));
    findMemberById.mockResolvedValue(member());
    completeTaskRpc.mockResolvedValue({
      status: 'DONE',
      completedAt: '2024-02-02T12:00:00Z',
      completedByMemberId: MEMBER_ID,
      awarded: 0,
    });

    const payload = await complete(CTX, TASK_ID, {
      completedByMemberId: MEMBER_ID,
    });

    expect(payload.points.awarded).toBe(0);
    expect(payload.task.status).toBe('DONE');
  });
});

describe('reopen — ordered checks surface precise error codes', () => {
  it('non-DONE task → 422 VALIDATION (R11.4)', async () => {
    findTaskById.mockResolvedValue(task({ status: 'TODO' }));

    await expect(reopen(CTX, TASK_ID)).rejects.toBeInstanceOf(ValidationError);
    // The pre-check short-circuits before the RPC.
    expect(reopenTaskRpc).not.toHaveBeenCalled();
  });

  it('foreign task → 404 NOT_FOUND (R11.8)', async () => {
    findTaskById.mockResolvedValue(task({ family_id: OTHER_FAMILY_ID }));

    await expect(reopen(CTX, TASK_ID)).rejects.toBeInstanceOf(NotFound);
    expect(reopenTaskRpc).not.toHaveBeenCalled();
  });

  it('missing task → 404 NOT_FOUND (R11.8)', async () => {
    findTaskById.mockResolvedValue(null);

    await expect(reopen(CTX, TASK_ID)).rejects.toBeInstanceOf(NotFound);
    expect(reopenTaskRpc).not.toHaveBeenCalled();
  });

  it('DONE task reopens: returns the full updated task + reversedPoints (R11.1)', async () => {
    // First read (ownership + status) sees DONE; after the RPC the service
    // re-reads the task, now TODO.
    findTaskById
      .mockResolvedValueOnce(task({ status: 'DONE' }))
      .mockResolvedValueOnce(task({ status: 'TODO' }));
    reopenTaskRpc.mockResolvedValue({ status: 'TODO', reversedPoints: 10 });

    const payload = await reopen(CTX, TASK_ID);

    expect(reopenTaskRpc).toHaveBeenCalledWith(TASK_ID);
    expect(payload.reversedPoints).toBe(10);
    expect(payload.task.id).toBe(TASK_ID);
    expect(payload.task.status).toBe('TODO');
    // The payload carries the full TaskDTO shape (snake_case keys, no timestamps).
    expect(payload.task.family_id).toBe(FAMILY_ID);
    expect(payload.task).not.toHaveProperty('created_at');
  });
});
