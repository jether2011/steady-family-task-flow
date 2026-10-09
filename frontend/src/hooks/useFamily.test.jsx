import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// ---------------------------------------------------------------------------
// Task 19.2: optimistic-completion + rollback test for useCompleteTask
// (R22.1 optimistic DONE before the server responds, R22.2 rollback + toast on
// error, R22.3 awarded points only after server confirmation; R30.3 Frontend
// test suite covers "task completion with error rollback").
//
// We mock the tasks API module so `tasks.complete` resolves/rejects a deferred
// promise we control, letting us inspect the ['tasks'] cache during the
// optimistic window (before the server responds). We mock the toast dispatcher
// so we can assert the error toast fires on rollback.
// ---------------------------------------------------------------------------

// Hoisted mock state so the vi.mock factories (also hoisted) can reference it.
const mockState = vi.hoisted(() => ({
  // The current deferred `tasks.complete` call: { promise, resolve, reject }.
  completeDeferred: null,
}));

vi.mock('@/api/tasks.api', () => {
  const complete = vi.fn(() => {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    mockState.completeDeferred = { promise, resolve, reject };
    return promise;
  });
  return { tasks: { complete }, complete };
});

vi.mock('@/components/ui/use-toast', () => ({
  toast: vi.fn(),
}));

// Imported after the mocks are registered.
import { tasks } from '@/api/tasks.api';
import { toast } from '@/components/ui/use-toast';
import { useCompleteTask } from '@/hooks/useFamily';

const TASKS_KEY = ['tasks'];

function makeTask(overrides = {}) {
  return {
    id: 'task-1',
    title: 'Take out the trash',
    status: 'TODO',
    points: 10,
    ...overrides,
  };
}

/**
 * Build a QueryClient seeded with an initial ['tasks'] list and a wrapper that
 * provides it. Retries are disabled so a rejected mutation surfaces its error
 * immediately rather than being retried.
 */
function setup(initialTasks) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  queryClient.setQueryData(TASKS_KEY, initialTasks);

  const wrapper = ({ children }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );

  return { queryClient, wrapper };
}

beforeEach(() => {
  mockState.completeDeferred = null;
  tasks.complete.mockClear();
  toast.mockClear();
});

describe('useCompleteTask — optimistic completion + rollback (R22)', () => {
  it('optimistically marks the task DONE before the server responds (R22.1)', async () => {
    const initial = [makeTask({ id: 'task-1', status: 'TODO' })];
    const { queryClient, wrapper } = setup(initial);

    const { result } = renderHook(() => useCompleteTask(), { wrapper });

    // Kick off the completion. The mocked api returns a pending promise, so the
    // server has NOT responded yet when we inspect the cache below.
    act(() => {
      result.current.mutate({ taskId: 'task-1', completedByMemberId: 'm-1' });
    });

    // onMutate runs asynchronously (it awaits cancelQueries). Wait for the
    // optimistic write to land, but note the server promise is still pending.
    await waitFor(() => {
      const cached = queryClient.getQueryData(TASKS_KEY);
      expect(cached[0].status).toBe('DONE');
    });

    // The server call was made but has not resolved yet (optimistic window).
    expect(tasks.complete).toHaveBeenCalledTimes(1);
    expect(tasks.complete).toHaveBeenCalledWith('task-1', {
      completedByMemberId: 'm-1',
    });
    expect(result.current.isPending).toBe(true);
  });

  it('rolls back to the prior snapshot and fires an error toast on failure (R22.2)', async () => {
    const initial = [
      makeTask({ id: 'task-1', status: 'WORKING' }),
      makeTask({ id: 'task-2', status: 'TODO' }),
    ];
    const { queryClient, wrapper } = setup(initial);
    const snapshotBefore = queryClient.getQueryData(TASKS_KEY);

    const { result } = renderHook(() => useCompleteTask(), { wrapper });

    act(() => {
      result.current.mutate({ taskId: 'task-1', completedByMemberId: 'm-1' });
    });

    // Optimistic phase: task-1 flips to DONE, task-2 is untouched.
    await waitFor(() => {
      expect(queryClient.getQueryData(TASKS_KEY)[0].status).toBe('DONE');
    });
    expect(queryClient.getQueryData(TASKS_KEY)[1].status).toBe('TODO');

    // Reject the in-flight completion -> onError restores the snapshot.
    await act(async () => {
      mockState.completeDeferred.reject(new Error('network down'));
      await mockState.completeDeferred.promise.catch(() => {});
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    // Cache is restored to the exact pre-mutation state.
    const restored = queryClient.getQueryData(TASKS_KEY);
    expect(restored[0].status).toBe('WORKING');
    expect(restored).toEqual(snapshotBefore);

    // A destructive error toast fired with the server message.
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({
        variant: 'destructive',
        description: 'network down',
      }),
    );
  });

  it('reflects awarded points only after the server confirms, not during the optimistic phase (R22.3)', async () => {
    const initial = [makeTask({ id: 'task-1', status: 'TODO' })];
    const { queryClient, wrapper } = setup(initial);

    const { result } = renderHook(() => useCompleteTask(), { wrapper });

    act(() => {
      result.current.mutate({ taskId: 'task-1', completedByMemberId: 'm-1' });
    });

    // Optimistic window: status is DONE but NO awarded points exist yet —
    // neither on the mutation result nor written into the task cache.
    await waitFor(() => {
      expect(queryClient.getQueryData(TASKS_KEY)[0].status).toBe('DONE');
    });
    expect(result.current.data).toBeUndefined();
    const optimisticTask = queryClient.getQueryData(TASKS_KEY)[0];
    expect(optimisticTask.points).toBe(10); // unchanged base points
    expect(optimisticTask).not.toHaveProperty('awarded');

    // Server confirms with the awarded points (CompleteTaskPayload shape).
    const serverPayload = {
      task: { status: 'DONE', completedAt: '2024-01-01T00:00:00.000Z' },
      completion: { completedByMemberId: 'm-1' },
      points: { awarded: 10 },
    };
    await act(async () => {
      mockState.completeDeferred.resolve(serverPayload);
      await mockState.completeDeferred.promise;
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    // Awarded points are available only now, from the server response.
    expect(result.current.data).toEqual(serverPayload);
    expect(result.current.data.points.awarded).toBe(10);
  });

  it('invalidates both ["tasks"] and ["points"] on settle (R22.3 reconciliation)', async () => {
    const initial = [makeTask({ id: 'task-1', status: 'TODO' })];
    const { queryClient, wrapper } = setup(initial);
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useCompleteTask(), { wrapper });

    act(() => {
      result.current.mutate({ taskId: 'task-1', completedByMemberId: 'm-1' });
    });

    await waitFor(() => {
      expect(queryClient.getQueryData(TASKS_KEY)[0].status).toBe('DONE');
    });

    await act(async () => {
      mockState.completeDeferred.resolve({
        task: { status: 'DONE', completedAt: '2024-01-01T00:00:00.000Z' },
        completion: { completedByMemberId: 'm-1' },
        points: { awarded: 10 },
      });
      await mockState.completeDeferred.promise;
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    const invalidatedKeys = invalidateSpy.mock.calls.map(
      ([arg]) => arg?.queryKey?.[0],
    );
    expect(invalidatedKeys).toContain('tasks');
    expect(invalidatedKeys).toContain('points');
  });
});
