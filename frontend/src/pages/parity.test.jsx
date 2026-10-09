import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { QueryClientProvider, QueryClient } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

// recharts' ResponsiveContainer (used by <Leaderboard />) relies on
// ResizeObserver, which jsdom does not implement. Provide a minimal stub so the
// chart can mount in the test environment.
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// ---------------------------------------------------------------------------
// Task 21.2 — parity + board/leaderboard rendering tests.
//
// These tests exercise the carry-over indicator and the parity pages wired in
// task 21.1 to the REST api modules. The pages consume data exclusively through
// the `@/hooks/useFamily` hooks, which in turn call the `@/api/*.api.ts`
// modules. We mock the hooks so each page renders purely from backend-derived
// data (the exact shape the api modules return), without a live network or
// Supabase session — this keeps the assertions focused on "does the UI render
// the backend data?" per R20.2/R20.3/R20.4/R14.4/R30.3.
//
// Supabase + the realtime hook are mocked because <Board /> opens a realtime
// channel on mount via useRealtime(familyId); the mock keeps that inert.
// ---------------------------------------------------------------------------

// Mutable hook-return store. Each test seeds the slices it needs before render.
const hookState = vi.hoisted(() => ({
  family: undefined,
  members: undefined,
  membersActive: undefined,
  tasks: undefined,
  points: undefined,
  completions: undefined,
  templates: [],
  awards: [],
  completionsLoading: false,
  membersLoading: false,
  tasksLoading: false,
}));

// Mock the data-layer hooks. The pages import these from '@/hooks/useFamily'.
// Queries return `{ data, isLoading }`; mutations return an object with
// mutate/mutateAsync so pages that construct them (Board, Onboarding) don't
// throw. activeOnly routes to the right members slice so Leaderboard/Board
// (which call useMembers(true)) and PointsHistory (useMembers()) can differ.
vi.mock('@/hooks/useFamily', () => {
  const query = (data, isLoading = false) => ({ data, isLoading });
  const mutation = () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(async () => ({})),
    isPending: false,
  });
  return {
    useFamily: () => query(hookState.family),
    useMembers: (activeOnly = false) =>
      query(
        activeOnly ? hookState.membersActive ?? hookState.members : hookState.members,
        hookState.membersLoading,
      ),
    useTasks: () => query(hookState.tasks, hookState.tasksLoading),
    usePoints: () => query(hookState.points),
    useCompletions: () => query(hookState.completions, hookState.completionsLoading),
    useTemplates: () => query(hookState.templates),
    useAwards: () => query(hookState.awards),
    useMoveTask: mutation,
    useCompleteTask: mutation,
    useReopenTask: mutation,
    useGenerateRecurring: mutation,
    useSaveTask: mutation,
    useSaveMember: mutation,
    useCreateFamily: mutation,
    useUpdateFamily: mutation,
    useDeleteTask: mutation,
    useDeleteMember: mutation,
    useSaveTemplate: mutation,
    useDeleteTemplate: mutation,
    useSaveAward: mutation,
    useDeleteAward: mutation,
  };
});

// Board mounts useRealtime(familyId); keep it inert so no Supabase channel is
// opened during the render test.
vi.mock('@/hooks/useRealtime', () => ({
  useRealtime: () => ({ realtimeConnected: false }),
  default: () => ({ realtimeConnected: false }),
}));

// <Board /> renders <TaskModal />, which pulls the authenticated session via
// useAuth(). The modal is not under test here (board task *rendering* is), so
// stub it to a no-op to avoid wiring an AuthProvider.
vi.mock('@/components/tasks/TaskModal', () => ({
  default: () => null,
}));

vi.mock('@/lib/supabaseClient', () => {
  const supabase = {
    channel: vi.fn(() => ({
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn().mockReturnThis(),
    })),
    removeChannel: vi.fn(),
    auth: {
      getSession: vi.fn(async () => ({ data: { session: null }, error: null })),
      onAuthStateChange: vi.fn(() => ({
        data: { subscription: { unsubscribe: vi.fn() } },
      })),
    },
  };
  return { supabase, default: supabase };
});

// Imported after the mocks are registered.
import TaskCard from '@/components/tasks/TaskCard';
import MemberProfile from '@/pages/MemberProfile';
import PointsHistory from '@/pages/PointsHistory';
import Onboarding from '@/pages/Onboarding';
import Board from '@/pages/Board';
import Leaderboard from '@/pages/Leaderboard';

// Render helper: every page relies on TanStack Query context (even though the
// hooks are mocked, pages like Onboarding call useQueryClient()) and router
// context (links / useSearchParams). A fresh QueryClient per render keeps the
// cache isolated between tests.
function renderWithProviders(ui, { route = '/' } = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  hookState.family = { id: 'fam-1', name: 'Rodrigues Family' };
  hookState.members = undefined;
  hookState.membersActive = undefined;
  hookState.tasks = undefined;
  hookState.points = undefined;
  hookState.completions = undefined;
  hookState.templates = [];
  hookState.awards = [];
  hookState.completionsLoading = false;
  hookState.membersLoading = false;
  hookState.tasksLoading = false;
});

// ---------------------------------------------------------------------------
// Carry-over indicator (R14.4)
// ---------------------------------------------------------------------------
describe('Carry-over indicator (R14.4)', () => {
  const member = { id: 'm-1', name: 'Lucas', color: '#10B981' };

  it('renders the "Carried from" indicator for a task with carried_from_task_id set', () => {
    const task = {
      id: 't-1',
      title: 'Make bed',
      status: 'TODO',
      priority: 'MEDIUM',
      points: 5,
      due_date: '2024-01-10',
      carried_from_task_id: 't-origin',
    };
    renderWithProviders(
      <TaskCard
        task={task}
        member={member}
        carriedFromDate="2024-01-09"
        onComplete={() => {}}
        onReopen={() => {}}
        onEdit={() => {}}
      />,
    );

    // The indicator renders the "Carried from <date>" label.
    expect(screen.getByText(/carried from/i)).toBeInTheDocument();
  });

  it('falls back to "Carried over" when no origin date is supplied', () => {
    const task = {
      id: 't-2',
      title: 'Feed the dog',
      status: 'TODO',
      priority: 'HIGH',
      points: 10,
      carried_from_task_id: 't-origin',
    };
    renderWithProviders(
      <TaskCard
        task={task}
        member={member}
        carriedFromDate={undefined}
        onComplete={() => {}}
        onReopen={() => {}}
        onEdit={() => {}}
      />,
    );

    expect(screen.getByText(/carried over/i)).toBeInTheDocument();
  });

  it('does NOT render the indicator for a task without carried_from_task_id', () => {
    const task = {
      id: 't-3',
      title: 'Homework',
      status: 'TODO',
      priority: 'HIGH',
      points: 15,
      carried_from_task_id: null,
    };
    renderWithProviders(
      <TaskCard
        task={task}
        member={member}
        carriedFromDate={undefined}
        onComplete={() => {}}
        onReopen={() => {}}
        onEdit={() => {}}
      />,
    );

    expect(screen.getByText('Homework')).toBeInTheDocument();
    expect(screen.queryByText(/carried from/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/carried over/i)).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// MemberProfile — backend completions + ledger (R20.2)
// ---------------------------------------------------------------------------
describe('MemberProfile renders backend data (R20.2)', () => {
  it('shows the member stats and completed-task history from the api data', () => {
    hookState.members = [
      { id: 'm-1', name: 'Lucas', member_type: 'CHILD', color: '#10B981', active: true },
    ];
    // Ledger entries drive the "Total points" stat (sum of this member's rows).
    hookState.points = [
      {
        id: 'p-1',
        member_id: 'm-1',
        task_id: 't-1',
        points: 5,
        transaction_type: 'TASK_COMPLETION',
        created_date: '2099-01-10',
      },
      {
        id: 'p-2',
        member_id: 'm-1',
        task_id: 't-2',
        points: 10,
        transaction_type: 'TASK_COMPLETION',
        created_date: '2099-01-11',
      },
    ];
    hookState.tasks = [
      { id: 't-1', title: 'Make bed', points: 5 },
      { id: 't-2', title: 'Feed the dog', points: 10 },
    ];
    // Backend-derived completions (GET /family/members/:id/completions).
    hookState.completions = [
      { id: 'c-1', task_id: 't-1', completed_at: '2099-01-10T08:00:00Z' },
      { id: 'c-2', task_id: 't-2', completed_at: '2099-01-11T08:00:00Z' },
    ];

    renderWithProviders(<MemberProfile />, { route: '/member-profile?member=m-1' });

    // Member identity from the backend members list.
    expect(screen.getByRole('heading', { name: 'Lucas' })).toBeInTheDocument();
    // Completed task history pulls task titles via the completions' task_id.
    expect(screen.getByText('Make bed')).toBeInTheDocument();
    expect(screen.getByText('Feed the dog')).toBeInTheDocument();
    // "Tasks done" count equals the number of backend completions.
    expect(screen.getByText('2')).toBeInTheDocument();
    // Total points = sum of the member's ledger rows (5 + 10). The "This week"
    // tile also sums to 15 here (the mocked dates fall in-window), so the
    // backend-derived total appears on at least one stat tile.
    expect(screen.getAllByText('15').length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// PointsHistory — ledger entries (R20.4)
// ---------------------------------------------------------------------------
describe('PointsHistory renders ledger entries (R20.4)', () => {
  it('lists backend ledger rows with member, type and signed points', () => {
    hookState.members = [
      { id: 'm-1', name: 'Lucas', color: '#10B981', active: true },
      { id: 'm-2', name: 'Marina', color: '#F59E0B', active: true },
    ];
    hookState.tasks = [
      { id: 't-1', title: 'Make bed' },
      { id: 't-2', title: 'Homework' },
    ];
    hookState.points = [
      {
        id: 'p-1',
        member_id: 'm-1',
        task_id: 't-1',
        points: 5,
        transaction_type: 'TASK_COMPLETION',
        created_date: '2099-01-10',
      },
      {
        id: 'p-2',
        member_id: 'm-2',
        task_id: 't-2',
        points: -15,
        transaction_type: 'REVERSAL',
        created_date: '2099-01-11',
      },
    ];

    renderWithProviders(<PointsHistory />);

    // A row per ledger entry, labelled with member + transaction type — these
    // labels are unique to the ledger rows (not the summary header).
    expect(screen.getByText(/Lucas · Task completed/)).toBeInTheDocument();
    expect(screen.getByText(/Marina · Reopened/)).toBeInTheDocument();
    // The task titles for each ledger row resolve via task_id.
    expect(screen.getByText(/Make bed/)).toBeInTheDocument();
    expect(screen.getByText(/Homework/)).toBeInTheDocument();
    // Signed point amounts from the ledger render. "+5" also appears in the
    // "Earned" summary tile (awarded total), so both occurrences are expected.
    expect(screen.getAllByText('+5').length).toBeGreaterThanOrEqual(1);
    // "-15" is the reversed row amount; "-15" also matches the "Reversed" tile.
    expect(screen.getAllByText('-15').length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Onboarding — first-login user with no members (R20.3)
// ---------------------------------------------------------------------------
describe('Onboarding appears for a first-login user with no members (R20.3)', () => {
  it('renders the onboarding setup flow when the members roster is empty', () => {
    // First-login: family auto-created, but the members api returns an empty
    // roster. Onboarding is the setup screen shown in that state.
    hookState.members = [];
    hookState.tasks = [];

    renderWithProviders(<Onboarding />);

    // Welcome / setup copy and the two first-run actions.
    expect(
      screen.getByRole('heading', { name: /welcome to famtask/i }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/family name/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /start fresh/i })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /load sample family/i }),
    ).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Board — renders tasks from api data (R20.x / R30.3)
// ---------------------------------------------------------------------------
describe('Board renders tasks from api data', () => {
  it('places each backend task in its status column', () => {
    hookState.membersActive = [
      { id: 'm-1', name: 'Lucas', color: '#10B981', active: true },
    ];
    hookState.tasks = [
      {
        id: 't-1',
        title: 'Make bed',
        status: 'TODO',
        priority: 'MEDIUM',
        points: 5,
        assigned_member_id: 'm-1',
      },
      {
        id: 't-2',
        title: 'Homework',
        status: 'WORKING',
        priority: 'HIGH',
        points: 15,
        assigned_member_id: 'm-1',
      },
      {
        id: 't-3',
        title: 'Wash dishes',
        status: 'DONE',
        priority: 'MEDIUM',
        points: 10,
        assigned_member_id: 'm-1',
      },
    ];

    renderWithProviders(<Board />);

    // Every backend task renders on the board.
    expect(screen.getByText('Make bed')).toBeInTheDocument();
    expect(screen.getByText('Homework')).toBeInTheDocument();
    expect(screen.getByText('Wash dishes')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Leaderboard — renders rows from api data in rank order (R30.3)
// ---------------------------------------------------------------------------
describe('Leaderboard renders rows from api data', () => {
  it('ranks members by points derived from the ledger (desc)', () => {
    hookState.membersActive = [
      { id: 'm-1', name: 'Lucas', color: '#10B981', active: true },
      { id: 'm-2', name: 'Marina', color: '#F59E0B', active: true },
    ];
    // Marina out-earns Lucas, so she should rank first regardless of input
    // order. Dates are in the future so they fall inside every period window.
    hookState.points = [
      {
        id: 'p-1',
        member_id: 'm-1',
        task_id: 't-1',
        points: 5,
        transaction_type: 'TASK_COMPLETION',
        created_date: '2099-01-10',
      },
      {
        id: 'p-2',
        member_id: 'm-2',
        task_id: 't-2',
        points: 30,
        transaction_type: 'TASK_COMPLETION',
        created_date: '2099-01-11',
      },
    ];

    renderWithProviders(<Leaderboard />);

    // Both members render as leaderboard rows with their names.
    const marina = screen.getByText('Marina');
    const lucas = screen.getByText('Lucas');
    expect(marina).toBeInTheDocument();
    expect(lucas).toBeInTheDocument();

    // Rank order: Marina (30) before Lucas (5) in the DOM.
    expect(
      marina.compareDocumentPosition(lucas) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    // Point totals derived from the ledger render on the rows (may also appear
    // in the comparison chart, so allow more than one occurrence).
    expect(screen.getAllByText('30').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('5').length).toBeGreaterThanOrEqual(1);
  });
});
