import { useQuery, useInfiniteQuery } from '@tanstack/react-query';
import { memberViews } from '@/api/memberViews.api';
import { dashboard } from '@/api/dashboard.api';
import { useScope } from './useScope';
export function useScopedQuery(parts, queryFn, options = {}) {
  const scope = useScope();
  return useQuery({
    queryKey: scope.key(...parts),
    queryFn,
    refetchInterval: 30000,
    refetchOnWindowFocus: true,
    ...options,
    enabled: scope.enabled && (options.enabled ?? true),
  });
}
export const usePersonalDashboard = () =>
  useScopedQuery(['personal-dashboard'], ({ signal }) =>
    memberViews.dashboard(signal),
  );
export const useDirectory = () =>
  useScopedQuery(['directory'], ({ signal }) => memberViews.directory(signal));
export const useSharedBoard = (weekStart) =>
  useScopedQuery(['board', weekStart], ({ signal }) =>
    dashboard.board(weekStart, signal),
  );
export const useLeaderboard = (period) =>
  useScopedQuery(['leaderboard', period], ({ signal }) =>
    memberViews.leaderboard(period, signal),
  );
export const usePointsSummary = (filter) =>
  useScopedQuery(['summary', filter], ({ signal }) =>
    memberViews.summary(filter, signal),
  );
export function useProfile(id) {
  return useScopedQuery(
    ['profile', id],
    ({ signal }) => memberViews.profile(id, signal),
    { enabled: !!id },
  );
}
export function useHistory(filter = {}) {
  const scope = useScope();
  return useInfiniteQuery({
    queryKey: scope.key('history', filter),
    queryFn: ({ pageParam, signal }) =>
      memberViews.points({ ...filter, cursor: pageParam }, signal),
    initialPageParam: undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: scope.enabled,
    refetchInterval: 30000,
    refetchOnWindowFocus: true,
  });
}
export function useWorkHistory(id) {
  const scope = useScope();
  return useInfiniteQuery({
    queryKey: scope.key('work-history', id),
    queryFn: ({ pageParam, signal }) =>
      memberViews.completions(id, pageParam, signal),
    initialPageParam: undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: scope.enabled && !!id,
    refetchInterval: 30000,
    refetchOnWindowFocus: true,
  });
}

export const useCatalog = () =>
  useScopedQuery(['catalog'], ({ signal }) => memberViews.catalog(signal));
