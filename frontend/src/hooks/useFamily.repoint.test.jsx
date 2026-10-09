/**
 * Hook-repoint + member-management tests for `src/hooks/useFamily.js`.
 *
 * After the Base44 → REST migration (DP-1), every hook sources its data from
 * the typed per-domain api modules (`@/api/*.api`) while keeping its EXACT
 * TanStack Query key and invalidation targets so pages/components do not change
 * (R24.1, R24.3). These tests pin that contract:
 *
 *   1. Each query hook fetches through the correct api module AND registers
 *      under its unchanged query key.
 *   2. Each mutation hook calls the correct api module AND invalidates the
 *      exact query key(s) it is supposed to.
 *   3. Member add / edit / deactivate flows work end-to-end against the mocked
 *      members api module (create → list reflects it; edit → updated;
 *      deactivate → DELETE sets active=false / drops from the active list)
 *      with the correct api calls and cache invalidation (R30.3).
 *
 * The api modules are mocked so no network/`fetch` is touched; we assert on the
 * query cache the hooks populate and on the mock api call arguments. The
 * optimistic-completion/rollback behavior of `useCompleteTask` is covered
 * separately in `useFamily.test.jsx` (task 19.2); here we only pin its api
 * target and invalidation keys.
 *
 * _Requirements: 24.1, 24.3, 30.3_
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor, act } from '@testing-library/react';

// ---------------------------------------------------------------------------
// Mock every api module the hook file imports. Each export is a vi.fn so we can
// assert the hook routes through the right function with the right arguments.
// ---------------------------------------------------------------------------

vi.mock('@/api/family.api', () => ({
  family: { get: vi.fn(), update: vi.fn() },
}));
vi.mock('@/api/members.api', () => ({
  members: {
    list: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
  },
}));
vi.mock('@/api/tasks.api', () => ({
  tasks: {
    list: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    move: vi.fn(),
    complete: vi.fn(),
    reopen: vi.fn(),
  },
}));
vi.mock('@/api/templates.api', () => ({
  templates: {
    list: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    generate: vi.fn(),
  },
}));
vi.mock('@/api/points.api', () => ({
  points: { list: vi.fn(), memberCompletions: vi.fn() },
}));
vi.mock('@/api/awards.api', () => ({
  awards: {
    list: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
  },
}));

// The complete-task mutation surfaces failures via this non-hook toast
// dispatcher; mock it so onError does not reach into real toast state.
vi.mock('@/components/ui/use-toast', () => ({
  toast: vi.fn(),
}));

import { family } from '@/api/family.api';
import { members } from '@/api/members.api';
import { tasks } from '@/api/tasks.api';
import { templates } from '@/api/templates.api';
import { points } from '@/api/points.api';
import { awards } from '@/api/awards.api';

import {
  useFamily,
  useMembers,
  useTasks,
  usePoints,
  useTemplates,
  useCompletions,
  useAwards,
  useSaveMember,
  useDeleteMember,
  useCompleteTask,
  useReopenTask,
  useGenerateRecurring,
} from '@/hooks/useFamily';

// ---------------------------------------------------------------------------
// Harness: a fresh QueryClient per test so caches never leak between cases.
// Retries are disabled so a rejected mutation surfaces immediately.
// ---------------------------------------------------------------------------

/** @type {QueryClient} */
let queryClient;

function makeWrapper() {
  queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  // eslint-disable-next-line react/prop-types
  return ({ children }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

/** Render a hook wrapped in a provider backed by the shared `queryClient`. */
function renderWithClient(hook) {
  return renderHook(hook, { wrapper: makeWrapper() });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  queryClient?.clear();
});

// ===========================================================================
// Query hooks: correct api module + unchanged query key (R24.1, R24.3)
// ===========================================================================

describe('query hooks fetch through the correct api module under their exact key', () => {
  it('useFamily → family.get() under ["family"]', async () => {
    const data = { id: 'fam-1', name: 'Rodrigues' };
    family.get.mockResolvedValue(data);

    const { result } = renderWithClient(() => useFamily());

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(family.get).toHaveBeenCalledTimes(1);
    expect(result.current.data).toEqual(data);
    expect(queryClient.getQueryData(['family'])).toEqual(data);
  });

  it('useMembers(false) → members.list(undefined) under ["members", { activeOnly: false }]', async () => {
    const roster = [{ id: 'm1', active: true }];
    members.list.mockResolvedValue(roster);

    const { result } = renderWithClient(() => useMembers(false));

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    // activeOnly=false → the hook passes undefined (no server-side filter).
    expect(members.list).toHaveBeenCalledWith(undefined, expect.anything());
    expect(queryClient.getQueryData(['members', { activeOnly: false }])).toEqual(
      roster,
    );
  });

  it('useMembers(true) → members.list(true) under ["members", { activeOnly: true }]', async () => {
    const roster = [{ id: 'm1', active: true }];
    members.list.mockResolvedValue(roster);

    const { result } = renderWithClient(() => useMembers(true));

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(members.list).toHaveBeenCalledWith(true, expect.anything());
    expect(queryClient.getQueryData(['members', { activeOnly: true }])).toEqual(
      roster,
    );
  });

  it('useTasks(filters) → tasks.list(mapped filter) under ["tasks", filters]', async () => {
    const list = [{ id: 't1', status: 'TODO' }];
    tasks.list.mockResolvedValue(list);
    const filters = {
      weekStart: '2024-01-01',
      dueDate: '2024-01-03',
      status: 'TODO',
      memberId: 'm1',
    };

    const { result } = renderWithClient(() => useTasks(filters));

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    // The hook keeps `dueDate` publicly but maps it to the REST `date` field.
    expect(tasks.list).toHaveBeenCalledWith(
      {
        weekStart: '2024-01-01',
        date: '2024-01-03',
        status: 'TODO',
        memberId: 'm1',
      },
      expect.anything(),
    );
    // The query key preserves the ORIGINAL public filter shape (with dueDate).
    expect(queryClient.getQueryData(['tasks', filters])).toEqual(list);
  });

  it('usePoints → points.list({}) under ["points"]', async () => {
    const ledger = [{ id: 'p1', points: 10 }];
    points.list.mockResolvedValue(ledger);

    const { result } = renderWithClient(() => usePoints());

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(points.list).toHaveBeenCalledWith({}, expect.anything());
    expect(queryClient.getQueryData(['points'])).toEqual(ledger);
  });

  it('useTemplates → templates.list() under ["templates"]', async () => {
    const tpls = [{ id: 'tpl1' }];
    templates.list.mockResolvedValue(tpls);

    const { result } = renderWithClient(() => useTemplates());

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(templates.list).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryData(['templates'])).toEqual(tpls);
  });

  it('useAwards → awards.list() under ["awards"]', async () => {
    const list = [{ id: 'a1' }];
    awards.list.mockResolvedValue(list);

    const { result } = renderWithClient(() => useAwards());

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(awards.list).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryData(['awards'])).toEqual(list);
  });

  it('useCompletions(id) → points.memberCompletions(id) unwrapped, under ["completions", id]', async () => {
    const completions = [{ id: 'c1' }];
    points.memberCompletions.mockResolvedValue({
      completions,
      transactions: [{ id: 'tx1' }],
    });

    const { result } = renderWithClient(() => useCompletions('m1'));

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(points.memberCompletions).toHaveBeenCalledWith(
      'm1',
      expect.anything(),
    );
    // The hook unwraps to the completions array only.
    expect(result.current.data).toEqual(completions);
    expect(queryClient.getQueryData(['completions', 'm1'])).toEqual(completions);
  });

  it('useCompletions is disabled when no memberId is given (no fetch)', async () => {
    const { result } = renderWithClient(() => useCompletions(undefined));

    // `enabled: !!memberId` → the query never runs.
    await waitFor(() => expect(result.current.fetchStatus).toBe('idle'));
    expect(points.memberCompletions).not.toHaveBeenCalled();
    expect(result.current.isSuccess).toBe(false);
  });
});

// ===========================================================================
// Mutation hooks: correct api module + exact invalidation targets (R24.3)
// ===========================================================================

describe('mutation hooks call the right api module and invalidate the exact keys', () => {
  it('useCompleteTask → tasks.complete(taskId, { completedByMemberId }) and invalidates tasks + points', async () => {
    tasks.complete.mockResolvedValue({ task: { id: 't1', status: 'DONE' } });

    const { result } = renderWithClient(() => useCompleteTask());
    const spy = vi.spyOn(queryClient, 'invalidateQueries');

    await act(async () => {
      await result.current.mutateAsync({
        taskId: 't1',
        completedByMemberId: 'm1',
      });
    });

    expect(tasks.complete).toHaveBeenCalledWith('t1', {
      completedByMemberId: 'm1',
    });
    // onSettled reconciles BOTH the board and the points ledger.
    expect(spy).toHaveBeenCalledWith({ queryKey: ['tasks'] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['points'] });
  });

  it('useReopenTask → tasks.reopen(taskId) and invalidates tasks + points', async () => {
    tasks.reopen.mockResolvedValue({ task: { id: 't1' }, reversedPoints: 5 });

    const { result } = renderWithClient(() => useReopenTask());
    const spy = vi.spyOn(queryClient, 'invalidateQueries');

    await act(async () => {
      await result.current.mutateAsync({ taskId: 't1' });
    });

    expect(tasks.reopen).toHaveBeenCalledWith('t1');
    expect(spy).toHaveBeenCalledWith({ queryKey: ['tasks'] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['points'] });
  });

  it('useGenerateRecurring → templates.generate({ weekStart }) and invalidates tasks', async () => {
    templates.generate.mockResolvedValue({ weekStart: 'w1', created: 3 });

    const { result } = renderWithClient(() => useGenerateRecurring());
    const spy = vi.spyOn(queryClient, 'invalidateQueries');

    await act(async () => {
      await result.current.mutateAsync({ weekStart: 'w1' });
    });

    expect(templates.generate).toHaveBeenCalledWith({ weekStart: 'w1' });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['tasks'] });
  });
});

// ===========================================================================
// Member management flows end-to-end against the mocked members api (R30.3)
// ===========================================================================

describe('member add / edit / deactivate flows (end-to-end against mocked members api)', () => {
  it('add: useSaveMember with no id → members.create, invalidates ["members"], and the active list then reflects it', async () => {
    const created = { id: 'm2', name: 'Ana', active: true };
    members.create.mockResolvedValue(created);

    const wrapper = makeWrapper();

    // Back the roster read with STATE, not a call-ordering queue. A queue
    // (`mockResolvedValueOnce` → `mockResolvedValue`) is order-dependent: it
    // assumes exactly one mount fetch before the invalidation refetch, so any
    // extra refetch (React Query remount/GC, or interleaving under parallel
    // file execution) consumes the "once" out of order and the final cache is
    // wrong. A stateful source returns the current roster for ANY number of
    // reads, so the test is deterministic regardless of refetch count/order.
    const roster = [];
    members.list.mockImplementation(async () => roster.slice());

    const listHook = renderHook(() => useMembers(true), { wrapper });
    await waitFor(() => expect(listHook.result.current.isSuccess).toBe(true));
    expect(listHook.result.current.data).toEqual([]);

    // Create a member (no id → create path). The stateful roster now includes it.
    members.create.mockImplementation(async () => {
      roster.push(created);
      return created;
    });
    const saveHook = renderHook(() => useSaveMember(), { wrapper });
    await act(async () => {
      await saveHook.result.current.mutateAsync({
        data: { name: 'Ana', memberType: 'CHILD' },
      });
    });

    expect(members.create).toHaveBeenCalledWith({
      name: 'Ana',
      memberType: 'CHILD',
    });
    expect(members.update).not.toHaveBeenCalled();

    // The active roster now reflects the newly created member. `findBy`-style
    // polling on the cache tolerates the async invalidation refetch landing
    // whenever it lands.
    await waitFor(() =>
      expect(
        queryClient.getQueryData(['members', { activeOnly: true }]),
      ).toEqual([created]),
    );
  });

  it('edit: useSaveMember with an id → members.update(id, data), and the list reflects the update', async () => {
    const updated = { id: 'm2', name: 'Ana Maria', active: true };

    const wrapper = makeWrapper();

    // Stateful roster: starts with the pre-edit member; the update mutation
    // mutates it in place so every refetch (mount or post-invalidation) returns
    // the current state. Deterministic regardless of refetch count/order.
    const roster = [{ id: 'm2', name: 'Ana', active: true }];
    members.list.mockImplementation(async () => roster.slice());
    members.update.mockImplementation(async (id, data) => {
      const idx = roster.findIndex((m) => m.id === id);
      if (idx >= 0) roster[idx] = { ...roster[idx], ...data };
      return roster[idx];
    });

    const listHook = renderHook(() => useMembers(true), { wrapper });
    await waitFor(() => expect(listHook.result.current.isSuccess).toBe(true));

    const saveHook = renderHook(() => useSaveMember(), { wrapper });
    await act(async () => {
      await saveHook.result.current.mutateAsync({
        id: 'm2',
        data: { name: 'Ana Maria' },
      });
    });

    // id present → update path, not create.
    expect(members.update).toHaveBeenCalledWith('m2', { name: 'Ana Maria' });
    expect(members.create).not.toHaveBeenCalled();

    // The invalidation-driven refetch lands the updated member in the roster
    // cache (assert the cache — the source of truth — so the result is not
    // sensitive to React re-render flush timing).
    await waitFor(() =>
      expect(
        queryClient.getQueryData(['members', { activeOnly: true }]),
      ).toEqual([updated]),
    );
  });

  it('deactivate: useDeleteMember → members.remove(id) (DELETE soft-delete) sets active=false and drops from the active list', async () => {
    const wrapper = makeWrapper();

    // Stateful ACTIVE roster: starts with the member; the soft-delete flips it
    // to active=false, so the active-filtered refetch (which models the
    // server-side `?active=true` filter) excludes it. Any number of refetches
    // in any order return the current active subset.
    const all = [{ id: 'm2', name: 'Ana', active: true }];
    members.list.mockImplementation(async (activeOnly) => {
      const rows = all.slice();
      return activeOnly ? rows.filter((m) => m.active) : rows;
    });
    // DELETE /family/members/:id is a soft delete (returns active=false).
    members.remove.mockImplementation(async (id) => {
      const idx = all.findIndex((m) => m.id === id);
      if (idx >= 0) all[idx] = { ...all[idx], active: false };
      return all[idx];
    });

    const listHook = renderHook(() => useMembers(true), { wrapper });
    await waitFor(() => expect(listHook.result.current.isSuccess).toBe(true));
    expect(listHook.result.current.data).toHaveLength(1);

    const deleteHook = renderHook(() => useDeleteMember(), { wrapper });
    let returned;
    await act(async () => {
      returned = await deleteHook.result.current.mutateAsync({ id: 'm2' });
    });

    // The hook forwards only the member id to the soft-delete endpoint.
    expect(members.remove).toHaveBeenCalledWith('m2');
    expect(returned.active).toBe(false);

    // After invalidation the active roster refetch excludes the deactivated member.
    await waitFor(() =>
      expect(
        queryClient.getQueryData(['members', { activeOnly: true }]),
      ).toEqual([]),
    );
    // The active-only query was issued with the server-side active filter.
    expect(members.list).toHaveBeenCalledWith(true, expect.anything());
  });

  it('useDeleteMember invalidates the ["members"] key (covers active and all rosters)', async () => {
    members.remove.mockResolvedValue({ id: 'm2', active: false });

    const { result } = renderWithClient(() => useDeleteMember());
    const spy = vi.spyOn(queryClient, 'invalidateQueries');

    await act(async () => {
      await result.current.mutateAsync({ id: 'm2' });
    });

    // A prefix ["members"] invalidation covers every ["members", { activeOnly }] cache.
    expect(spy).toHaveBeenCalledWith({ queryKey: ['members'] });
  });

  it('useSaveMember invalidates the ["members"] key after a successful save', async () => {
    members.create.mockResolvedValue({ id: 'm3', active: true });

    const { result } = renderWithClient(() => useSaveMember());
    const spy = vi.spyOn(queryClient, 'invalidateQueries');

    await act(async () => {
      await result.current.mutateAsync({ data: { name: 'Bob' } });
    });

    expect(spy).toHaveBeenCalledWith({ queryKey: ['members'] });
  });
});
