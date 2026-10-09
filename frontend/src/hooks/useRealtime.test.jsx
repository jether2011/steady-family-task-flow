import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// ---------------------------------------------------------------------------
// Task 18.2: realtime invalidation + fallback test (R21.1, R21.3).
//
// `useRealtime(familyId)` opens a single Supabase Realtime channel and keeps
// the TanStack Query cache in sync with Postgres changes:
//   - a change event invalidates the matching query keys (R21.1),
//   - the subscription is filtered to `family_id=eq.<familyId>` (R21.2),
//   - an unhealthy channel (CHANNEL_ERROR / TIMED_OUT / CLOSED) enables a
//     low-frequency polling fallback that invalidates the cache (R21.3),
//   - the channel is removed on unmount.
//
// We mock `@/lib/supabaseClient` so we can capture the registered
// `postgres_changes` handlers (keyed by table) and the `.subscribe()` status
// callback, then drive events/status transitions by hand.
// ---------------------------------------------------------------------------

const FALLBACK_INTERVAL_MS = 30_000;

// Hoisted mock state so the vi.mock factory (also hoisted) can reference it.
const mockState = vi.hoisted(() => ({
  // Captured postgres_changes handlers, keyed by table name.
  handlers: {},
  // The `.subscribe((status) => ...)` callback captured on subscribe.
  statusCallback: null,
  // Each `.on('postgres_changes', config, handler)` config, in order.
  onConfigs: [],
  // How many channels were created and the last channel name passed.
  channelCount: 0,
  lastChannelName: null,
  // Spies for channel lifecycle.
  subscribeSpy: null,
  removeChannelSpy: null,
}));

vi.mock('@/lib/supabaseClient', () => {
  const makeChannel = (name) => {
    mockState.channelCount += 1;
    mockState.lastChannelName = name;

    const channel = {
      on(event, config, handler) {
        if (event === 'postgres_changes') {
          mockState.onConfigs.push(config);
          mockState.handlers[config.table] = handler;
        }
        return channel; // chainable
      },
      subscribe(cb) {
        mockState.statusCallback = cb;
        mockState.subscribeSpy(cb);
        return channel;
      },
    };
    return channel;
  };

  const supabase = {
    channel: vi.fn((name) => makeChannel(name)),
    removeChannel: vi.fn((...args) => mockState.removeChannelSpy(...args)),
  };
  return { supabase, default: supabase };
});

// Imported after the mock is registered.
import { supabase } from '@/lib/supabaseClient';
import { useRealtime } from '@/hooks/useRealtime';

function resetMockState() {
  mockState.handlers = {};
  mockState.statusCallback = null;
  mockState.onConfigs = [];
  mockState.channelCount = 0;
  mockState.lastChannelName = null;
  mockState.subscribeSpy = vi.fn();
  mockState.removeChannelSpy = vi.fn();
}

/**
 * Render `useRealtime` inside a QueryClientProvider and return the hook result
 * along with the QueryClient and a spy on `invalidateQueries`.
 */
function renderUseRealtime(familyId) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

  const wrapper = ({ children }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );

  const view = renderHook(() => useRealtime(familyId), { wrapper });
  return { ...view, queryClient, invalidateSpy };
}

/** Keys passed to each invalidateQueries call, flattened for assertions. */
function invalidatedKeys(invalidateSpy) {
  return invalidateSpy.mock.calls.map(([arg]) => arg?.queryKey);
}

/** Drive the captured subscribe status callback; it updates React state. */
function emitStatus(status) {
  act(() => {
    mockState.statusCallback(status);
  });
}

describe('useRealtime', () => {
  beforeEach(() => {
    resetMockState();
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('subscribes to tasks / task_completions / points_transactions filtered to the family', () => {
    const familyId = 'fam-123';
    renderUseRealtime(familyId);

    // One channel opened, scoped to this family.
    expect(supabase.channel).toHaveBeenCalledTimes(1);
    expect(mockState.lastChannelName).toContain(familyId);

    // Three postgres_changes subscriptions, one per table, all filtered.
    const tables = mockState.onConfigs.map((c) => c.table).sort();
    expect(tables).toEqual([
      'points_transactions',
      'task_completions',
      'tasks',
    ]);

    for (const config of mockState.onConfigs) {
      expect(config.schema).toBe('public');
      expect(config.event).toBe('*');
      expect(config.filter).toBe(`family_id=eq.${familyId}`);
    }
  });

  it('invalidates [tasks] when a tasks change event fires', () => {
    const { invalidateSpy } = renderUseRealtime('fam-1');

    mockState.handlers.tasks({ eventType: 'UPDATE' });

    const keys = invalidatedKeys(invalidateSpy);
    expect(keys).toContainEqual(['tasks']);
    expect(keys).not.toContainEqual(['points']);
  });

  it('invalidates [points] when a points_transactions change event fires', () => {
    const { invalidateSpy } = renderUseRealtime('fam-1');

    mockState.handlers.points_transactions({ eventType: 'INSERT' });

    const keys = invalidatedKeys(invalidateSpy);
    expect(keys).toContainEqual(['points']);
    expect(keys).not.toContainEqual(['tasks']);
  });

  it('invalidates both [tasks] and [points] when a task_completions change event fires', () => {
    const { invalidateSpy } = renderUseRealtime('fam-1');

    mockState.handlers.task_completions({ eventType: 'INSERT' });

    const keys = invalidatedKeys(invalidateSpy);
    expect(keys).toContainEqual(['tasks']);
    expect(keys).toContainEqual(['points']);
  });

  it('reports realtimeConnected and does NOT poll while the channel is healthy (SUBSCRIBED)', () => {
    const { result, invalidateSpy } = renderUseRealtime('fam-1');

    emitStatus('SUBSCRIBED');
    expect(result.current.realtimeConnected).toBe(true);

    // No fallback polling while healthy, even after the interval elapses.
    invalidateSpy.mockClear();
    vi.advanceTimersByTime(FALLBACK_INTERVAL_MS * 2);
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it.each(['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'])(
    'enables the polling fallback when the subscription status is %s',
    (status) => {
      const { result, invalidateSpy } = renderUseRealtime('fam-1');

      emitStatus(status);
      expect(result.current.realtimeConnected).toBe(false);

      // Nothing polled before the interval elapses.
      invalidateSpy.mockClear();
      vi.advanceTimersByTime(FALLBACK_INTERVAL_MS - 1);
      expect(invalidateSpy).not.toHaveBeenCalled();

      // One interval tick => fallback invalidates both caches.
      vi.advanceTimersByTime(1);
      const keys = invalidatedKeys(invalidateSpy);
      expect(keys).toContainEqual(['tasks']);
      expect(keys).toContainEqual(['points']);

      // And it keeps polling on subsequent ticks.
      invalidateSpy.mockClear();
      vi.advanceTimersByTime(FALLBACK_INTERVAL_MS);
      expect(invalidatedKeys(invalidateSpy)).toContainEqual(['tasks']);
      expect(invalidatedKeys(invalidateSpy)).toContainEqual(['points']);
    },
  );

  it('stops the polling fallback once the channel recovers to SUBSCRIBED', () => {
    const { invalidateSpy } = renderUseRealtime('fam-1');

    // Unhealthy first: fallback starts.
    emitStatus('CHANNEL_ERROR');
    vi.advanceTimersByTime(FALLBACK_INTERVAL_MS);
    expect(invalidatedKeys(invalidateSpy)).toContainEqual(['tasks']);

    // Recover: fallback must stop polling.
    emitStatus('SUBSCRIBED');
    invalidateSpy.mockClear();
    vi.advanceTimersByTime(FALLBACK_INTERVAL_MS * 2);
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it('removes the channel and tears down the fallback on unmount', () => {
    const { unmount, invalidateSpy } = renderUseRealtime('fam-1');

    emitStatus('CHANNEL_ERROR'); // fallback running
    unmount();

    expect(supabase.removeChannel).toHaveBeenCalledTimes(1);

    // No further polling after unmount.
    invalidateSpy.mockClear();
    vi.advanceTimersByTime(FALLBACK_INTERVAL_MS * 2);
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it('does not open a channel when familyId is missing', () => {
    renderUseRealtime(undefined);
    expect(supabase.channel).not.toHaveBeenCalled();
  });
});
