import { get } from './client';
import type {
  Award,
  Member,
  Task,
  PointsTransaction,
  TaskCompletion,
  LeaderboardPeriod,
} from './types';
export type SafeMember = Pick<
  Member,
  'id' | 'name' | 'avatar_url' | 'color' | 'member_type' | 'active'
>;
export type SelfMember = SafeMember & { birth_year: number | null };
export interface PersonalDashboard {
  family: { id: string; name: string; avatar_url: string | null };
  member: SelfMember;
  balance: number;
  todayTasks: Task[];
  upcomingTasks: Task[];
  recentTransactions: PointsTransaction[];
  recentCompletions: TaskCompletion[];
  asOf: string;
}
export interface Summary {
  earned: number;
  adjustments: number;
  reversed: number;
  spent: number;
  net: number;
  balance: number;
}
export interface HistoryFilter {
  memberId?: string;
  from?: string;
  to?: string;
  type?: string;
  limit?: number;
  cursor?: string;
}
export interface RankedEntry {
  memberId: string;
  name: string;
  avatarUrl: string | null;
  color: string | null;
  points: number;
  completedTasks: number;
  rank: number;
}
export interface Ranking {
  entries: RankedEntry[];
  period: LeaderboardPeriod;
  from: string | null;
  asOf: string;
}
export type PublicAward = Pick<
  Award,
  'id' | 'title' | 'description' | 'points_cost' | 'icon' | 'color' | 'active'
>;
export const memberViews = {
  catalog: async (signal?: AbortSignal) =>
    (await get<{ awards: PublicAward[] }>('/family/awards', undefined, signal))
      .awards,
  dashboard: (signal?: AbortSignal) =>
    get<PersonalDashboard>('/family/member-dashboard', undefined, signal),
  directory: async (signal?: AbortSignal) =>
    (
      await get<{ members: SafeMember[] }>(
        '/family/member-directory',
        undefined,
        signal,
      )
    ).members,
  profile: (id: string, signal?: AbortSignal) =>
    get<{ member: SelfMember; balance: number }>(
      `/family/members/${id}/profile`,
      undefined,
      signal,
    ),
  points: (filter: HistoryFilter = {}, signal?: AbortSignal) =>
    get<{ transactions: PointsTransaction[]; nextCursor: string | null }>(
      '/family/points',
      { ...filter },
      signal,
    ),
  summary: (
    filter: Pick<HistoryFilter, 'memberId' | 'from' | 'to'> = {},
    signal?: AbortSignal,
  ) => get<Summary>('/family/points/summary', { ...filter }, signal),
  completions: (id: string, cursor?: string, signal?: AbortSignal) =>
    get<{
      completions: TaskCompletion[];
      transactions: PointsTransaction[];
      nextCursor: string | null;
    }>(`/family/members/${id}/completions`, { cursor }, signal),
  leaderboard: (period: LeaderboardPeriod, signal?: AbortSignal) =>
    get<Ranking>('/family/leaderboard', { period }, signal),
};
