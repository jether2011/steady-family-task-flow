import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
const state = vi.hoisted(() => ({
  role: 'MEMBER',
  fail: false,
  profile: vi.fn(),
  load: vi.fn(),
  history: vi.fn(),
}));
vi.mock('@/hooks/useScope', () => ({
  useScope: () => ({
    role: state.role,
    memberId: 'self',
    enabled: true,
    canManage: false,
  }),
}));
vi.mock('@/hooks/useMemberViews', () => {
  const self = {
    id: 'self',
    name: 'Me',
    member_type: 'CHILD',
    birth_year: 2010,
    color: '#abcdef',
    avatar_url: null,
    active: true,
  };
  const task = {
    id: 'task',
    title: 'Read a book',
    description: 'Shared details',
    status: 'TODO',
    priority: 'LOW',
    points: 0,
    due_date: '2026-10-15',
    assigned_member_id: 'self',
  };
  const query = (data) => ({
    data,
    isError: state.fail,
    isPending: false,
    isLoading: false,
    refetch: state.load,
  });
  return {
    useCatalog: () =>
      query([
        {
          id: 'award',
          title: 'Movie night',
          description: 'Family time',
          points_cost: 20,
          icon: '🎥',
          active: true,
        },
      ]),
    usePersonalDashboard: () =>
      query({
        family: { id: 'family', name: 'Home' },
        member: self,
        balance: -2,
        todayTasks: [task],
        upcomingTasks: [],
        recentTransactions: [],
        recentCompletions: [
          {
            id: 'complete',
            task_title: 'Zero-point work',
            awarded_points: 0,
            completed_at: '2026-10-15T10:00:00Z',
          },
        ],
        asOf: '2026-10-15T10:00:00Z',
      }),
    useDirectory: () => query([self, { ...self, id: 'other', name: 'Other' }]),
    useSharedBoard: () => query({ tasks: [task] }),
    useLeaderboard: () => query({ entries: [] }),
    useProfile: (id) => {
      state.profile(id);
      return query({ member: self, balance: -2 });
    },
    useWorkHistory: () => ({
      ...query({
        pages: [
          {
            completions: [
              {
                id: 'completion',
                task_id: 'task',
                task_title: 'Zero-point work',
                awarded_points: 0,
                completed_at: '2026-10-15T10:00:00Z',
              },
            ],
            transactions: [],
          },
        ],
      }),
      hasNextPage: true,
      fetchNextPage: state.load,
    }),
    useHistory: (filter) => {
      state.history(filter);
      return {
        ...query({
          pages: [
            {
              transactions: [
                {
                  id: 'point',
                  points: 5,
                  transaction_type: 'TASK_COMPLETION',
                  created_at: '2026-10-15T10:00:00Z',
                },
              ],
            },
          ],
        }),
        hasNextPage: true,
        fetchNextPage: state.load,
      };
    },
    usePointsSummary: () =>
      query({
        earned: 99,
        adjustments: 0,
        reversed: 100,
        spent: 1,
        net: -2,
        balance: -2,
      }),
  };
});
vi.mock('@/hooks/useFamily', () => ({
  useTasks: () => ({
    data: [
      {
        id: 'task',
        title: 'Read a book',
        description: 'Shared details',
        status: 'TODO',
        priority: 'LOW',
        points: 0,
        due_date: '2026-10-15',
        assigned_member_id: 'self',
      },
    ],
    isLoading: false,
    isPending: false,
    isError: false,
  }),
  useAwards: () => ({
    data: [
      {
        id: 'award',
        title: 'Movie night',
        description: 'Family time',
        points_cost: 20,
        icon: '🎥',
        active: true,
      },
    ],
    isLoading: false,
    isError: false,
  }),
}));
import Home from './Home';
import Board from './Board';
import Wall from './Wall';
import FamilyAwards from './FamilyAwards';
import MemberProfile from './MemberProfile';
import PointsHistory from './PointsHistory';
beforeEach(() => {
  state.role = 'MEMBER';
  state.fail = false;
  state.load.mockClear();
  state.profile.mockClear();
  state.history.mockClear();
});
function show(page, path = '/') {
  render(<MemoryRouter initialEntries={[path]}>{page}</MemoryRouter>);
}
describe('member views never mount management mutation hooks', () => {
  it('renders personal balance, assigned tasks and zero-point work independently of ledger rows', () => {
    show(<Home />);
    expect(screen.getByText('-2 points')).toBeInTheDocument();
    expect(screen.getByText('Read a book')).toBeInTheDocument();
    expect(screen.getByText(/Zero-point work/)).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Complete|Add task|Edit/i }),
    ).not.toBeInTheDocument();
  });
  it.each([
    ['board', <Board />],
    ['wall', <Wall />],
  ])(
    'renders view-only shared %s with no drag or complete controls',
    (_name, page) => {
      show(page);
      expect(screen.getByText('Read a book')).toBeInTheDocument();
      expect(screen.getByText(/view only/)).toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: /done|generate|edit|task/i }),
      ).not.toBeInTheDocument();
      expect(
        document.querySelector('[data-rfd-drag-handle-draggable-id]'),
      ).toBeNull();
    },
  );
  it('shows catalog and own balance without redemption or management controls', () => {
    show(<FamilyAwards />);
    expect(screen.getByText('Movie night')).toBeInTheDocument();
    expect(screen.getByText('My balance: -2 points')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /redeem|new award|delete|edit/i }),
    ).not.toBeInTheDocument();
  });
  it('rejects another profile URL before requesting data', () => {
    show(<MemberProfile />, '/member-profile?member=other');
    expect(screen.getByText('Profile unavailable')).toBeInTheDocument();
    expect(state.profile).not.toHaveBeenCalled();
  });
  it('uses own binding, keeps zero-point completion and loads further work pages', () => {
    show(<MemberProfile />, '/member-profile');
    expect(state.profile).toHaveBeenCalledWith('self');
    expect(screen.getByText('0 points awarded')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Load more work'));
    expect(state.load).toHaveBeenCalled();
  });
  it('shows full-range summary and paged history using authoritative timestamps', () => {
    show(<PointsHistory />);
    expect(screen.getByText('99')).toBeInTheDocument();
    expect(screen.getByText('+5')).toBeInTheDocument();
    expect(screen.queryByText('Invalid Date')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Member')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Activity'), {
      target: { value: 'REDEMPTION' },
    });
    expect(state.history).toHaveBeenLastCalledWith({ type: 'REDEMPTION' });
    fireEvent.click(screen.getByText('Load more points'));
    expect(state.load).toHaveBeenCalled();
  });
  it('gives an accessible error and retry instead of default family data', () => {
    state.fail = true;
    show(<Home />);
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load');
    fireEvent.click(
      screen.getByRole('button', { name: 'Retry personal dashboard' }),
    );
    expect(state.load).toHaveBeenCalled();
    expect(screen.queryByText('Read a book')).not.toBeInTheDocument();
  });
});
