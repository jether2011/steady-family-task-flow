import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabaseClient';

// Realtime cache invalidation for the Family Task Board (R21).
//
// `useRealtime(familyId)` opens a single Supabase Realtime channel for the
// authenticated RESPONSIBLE_User's family and keeps the TanStack Query cache in
// sync with Postgres changes, so multiple viewers (e.g. the Board and the Wall
// display) stay current without a manual reload.
//
// Design (see design.md → "Realtime subscription + cache invalidation"):
//   - Subscribe via `supabase.channel()` to postgres_changes on the `tasks`,
//     `task_completions`, and `points_transactions` tables, event '*', schema
//     'public', each filtered `family_id=eq.<familyId>` so the stream is scoped
//     to this family only (R21.2). RLS (anon key + user JWT) is the backstop.
//   - On any event, invalidate the matching query keys (R21.1):
//       tasks               -> ['tasks']
//       task_completions    -> ['tasks'] + ['points']  (a completion changes
//                              both the board task state and the ledger)
//       points_transactions -> ['points']
//   - Fallback (R21.3): track the channel's subscription status. While the
//     channel is unhealthy (never SUBSCRIBED, or CHANNEL_ERROR / TIMED_OUT /
//     CLOSED), run a low-frequency (30 s) interval that invalidates ['tasks']
//     and ['points'] so views still converge without realtime. The interval is
//     torn down as soon as the channel becomes healthy again, to conserve
//     energy on always-on Wall Mode displays.
//
// Fallback contract: the fallback is handled INTERNALLY (interval-driven
// invalidation) — consumers do not need to wire a `refetchInterval` into each
// query. The hook also returns `{ realtimeConnected }` so a consumer can react
// to connection state (e.g. show an "offline" badge) if it wants to.

const FALLBACK_INTERVAL_MS = 30_000; // low-frequency refresh while disconnected

export function useRealtime(familyId) {
  const queryClient = useQueryClient();
  const [realtimeConnected, setRealtimeConnected] = useState(false);

  // Keep the latest client in a ref so the fallback interval always invalidates
  // against the current QueryClient without being part of the effect deps.
  const queryClientRef = useRef(queryClient);
  queryClientRef.current = queryClient;

  useEffect(() => {
    if (!familyId) {
      setRealtimeConnected(false);
      return undefined;
    }

    const filter = `family_id=eq.${familyId}`;
    let fallbackTimer = null;

    const invalidateTasks = () =>
      queryClientRef.current.invalidateQueries({ queryKey: ['tasks'] });
    const invalidatePoints = () =>
      queryClientRef.current.invalidateQueries({ queryKey: ['points'] });

    const startFallback = () => {
      if (fallbackTimer !== null) return;
      fallbackTimer = setInterval(() => {
        invalidateTasks();
        invalidatePoints();
      }, FALLBACK_INTERVAL_MS);
    };

    const stopFallback = () => {
      if (fallbackTimer === null) return;
      clearInterval(fallbackTimer);
      fallbackTimer = null;
    };

    const channel = supabase
      .channel(`family-realtime:${familyId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'tasks', filter },
        invalidateTasks,
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'task_completions', filter },
        () => {
          // A completion/reopen touches both the board and the ledger.
          invalidateTasks();
          invalidatePoints();
        },
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'points_transactions', filter },
        invalidatePoints,
      )
      .subscribe((status) => {
        // `status` is one of: SUBSCRIBED | CHANNEL_ERROR | TIMED_OUT | CLOSED.
        if (status === 'SUBSCRIBED') {
          setRealtimeConnected(true);
          stopFallback();
        } else {
          // CHANNEL_ERROR / TIMED_OUT / CLOSED => realtime is unavailable, so
          // fall back to the low-frequency periodic refresh (R21.3).
          setRealtimeConnected(false);
          startFallback();
        }
      });

    return () => {
      stopFallback();
      supabase.removeChannel(channel);
      setRealtimeConnected(false);
    };
  }, [familyId]);

  return { realtimeConnected };
}

export default useRealtime;
