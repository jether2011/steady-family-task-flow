import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
afterEach(() => vi.useRealTimers());
function setup(id) {
  const client = new QueryClient();
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  const hook = renderHook(
    () => {
      return useRealtime(id);
    },
    {
      wrapper: ({ children }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    },
  );
  return { ...hook, invalidate };
}
import { useRealtime } from './useRealtime';
describe('authorized API refresh replaces raw realtime payloads', () => {
  it('polls visible queries and clears the timer on unmount', () => {
    vi.useFakeTimers();
    const hook = setup('family');
    expect(hook.result.current.realtimeConnected).toBe(false);
    act(() => vi.advanceTimersByTime(30000));
    expect(hook.invalidate).toHaveBeenCalledTimes(1);
    hook.unmount();
    act(() => vi.advanceTimersByTime(60000));
    expect(hook.invalidate).toHaveBeenCalledTimes(1);
  });
  it('does not poll without family context', () => {
    vi.useFakeTimers();
    const hook = setup(null);
    act(() => vi.advanceTimersByTime(60000));
    expect(hook.invalidate).not.toHaveBeenCalled();
    hook.unmount();
  });
  it('refreshes on focus and removes the listener when access ends', () => {
    const hook = setup('family');
    act(() => window.dispatchEvent(new Event('focus')));
    expect(hook.invalidate).toHaveBeenCalledTimes(1);
    hook.unmount();
    act(() => window.dispatchEvent(new Event('focus')));
    expect(hook.invalidate).toHaveBeenCalledTimes(1);
  });
});
