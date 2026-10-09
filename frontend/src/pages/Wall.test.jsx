/// <reference types="@testing-library/jest-dom" />
import React from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClientProvider, QueryClient } from '@tanstack/react-query';

// ---------------------------------------------------------------------------
// Mocks
//
// Task 20.2: Wall Mode test. The targets:
//   - R19.4 — Wall Mode requires an authenticated RESPONSIBLE_User session, so
//     unauthenticated viewers are gated by ProtectedRoute and never see Wall.
//   - R19.1 — the landscape board renders (per-member columns + the day's
//     tasks) from the data layer.
//   - R19.3 — while the device reports prefers-reduced-motion, non-essential
//     animation is suppressed in Wall Mode.
//   - R19.2 / R31.x — interactive controls carry >=44x44px touch-target classes
//     and focusable controls expose a visible focus ring.
//
// We mock the Supabase browser client exactly like the AuthContext test does so
// we can drive the session (signed out vs. authenticated), and stub the REST
// client's configureApiClient so the AuthProvider mount effect is inert. The
// data hooks Wall consumes (@/hooks/useFamily) and the realtime hook
// (@/hooks/useRealtime) are mocked so Wall renders from deterministic data
// without touching the network or a live Realtime channel. The toast seam is
// mocked to keep mutations inert.
// ---------------------------------------------------------------------------

const mockState = vi.hoisted(() => ({
  // Mutable "current session" the mocked getSession resolves with. Tests set
  // this via setSession() before rendering.
  currentSession: null,
}));

vi.mock('@/lib/supabaseClient', () => {
  const auth = {
    getSession: vi.fn(async () => ({
      data: { session: mockState.currentSession },
      error: null,
    })),
    onAuthStateChange: vi.fn(() => ({
      data: { subscription: { unsubscribe: vi.fn() } },
    })),
    signInWithOAuth: vi.fn(async () => ({ data: {}, error: null })),
    signOut: vi.fn(async () => ({ error: null })),
  };
  const supabase = { auth };
  return { supabase, default: supabase };
});

vi.mock('@/api/client', () => ({
  configureApiClient: vi.fn(),
}));

// Wall subscribes to realtime; keep it inert so no Supabase channel is opened.
vi.mock('@/hooks/useRealtime', () => ({
  useRealtime: vi.fn(() => ({ realtimeConnected: true })),
  default: vi.fn(() => ({ realtimeConnected: true })),
}));

vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: vi.fn() }),
  toast: vi.fn(),
}));

// Drive the data the Wall board renders from. Each hook returns the TanStack
// Query-shaped `{ data }` object Wall reads, plus a mutation shape for the
// complete/reopen hooks.
const mockData = vi.hoisted(() => ({
  family: null,
  members: [],
  tasks: [],
  transactions: [],
}));

vi.mock('@/hooks/useFamily', () => {
  const mutation = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false });
  return {
    useFamily: () => ({ data: mockData.family }),
    useMembers: () => ({ data: mockData.members }),
    useTasks: () => ({ data: mockData.tasks }),
    usePoints: () => ({ data: mockData.transactions }),
    useCompleteTask: mutation,
    useReopenTask: mutation,
  };
});

// Imported after the mocks are registered.
import { supabase } from '@/lib/supabaseClient';
import { AuthProvider } from '@/lib/AuthContext';
import ProtectedRoute from '@/components/ProtectedRoute';
import Login from '@/pages/Login';
import Wall from '@/pages/Wall';
import { todayKey } from '@/lib/familyUtils';

const AUTHENTICATED_SESSION = {
  access_token: 'test-access-token',
  user: {
    id: 'user-123',
    email: 'parent@example.com',
    user_metadata: { full_name: 'Test Parent' },
  },
};

function setSession(session) {
  mockState.currentSession = session;
}

function setBoardData() {
  const today = todayKey();
  mockData.family = { id: 'fam-1', name: 'The Testers' };
  mockData.members = [
    { id: 'm1', name: 'Ada Lovelace', color: '#4F46E5', active: true },
    { id: 'm2', name: 'Alan Turing', color: '#10B981', active: true },
  ];
  mockData.tasks = [
    {
      id: 't1',
      title: 'Wash the dishes',
      status: 'TODO',
      priority: 'HIGH',
      points: 10,
      due_date: today,
      assigned_member_id: 'm1',
    },
    {
      id: 't2',
      title: 'Take out the trash',
      status: 'DONE',
      priority: 'LOW',
      points: 5,
      due_date: today,
      assigned_member_id: 'm2',
    },
  ];
  mockData.transactions = [
    {
      member_id: 'm2',
      points: 5,
      transaction_type: 'TASK_COMPLETION',
      created_date: today,
    },
  ];
}

/** Replace window.matchMedia with a stub that reports the given reduced-motion
 *  preference. jsdom ships no real matchMedia, so without this any matchMedia
 *  caller (and the preference check under test) would throw. */
function stubMatchMedia(prefersReducedMotion) {
  window.matchMedia = vi.fn().mockImplementation((query) => ({
    matches:
      query.includes('prefers-reduced-motion: reduce') && prefersReducedMotion,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

/** Render Wall behind ProtectedRoute, matching how App.jsx gates every route. */
function renderGatedWall() {
  render(
    <AuthProvider>
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={['/wall']}>
          <Routes>
            <Route element={<ProtectedRoute unauthenticatedElement={<Login />} />}>
              <Route path="/wall" element={<Wall />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </AuthProvider>,
  );
}

beforeEach(() => {
  setSession(null);
  mockData.family = null;
  mockData.members = [];
  mockData.tasks = [];
  mockData.transactions = [];
  // `supabase` is the mocked client; cast to any so the vi mock helpers
  // (mockClear) are reachable without pulling in the real Supabase types, which
  // the typecheck config applies to .jsx files under src/pages.
  /** @type {any} */ (supabase).auth.signInWithOAuth.mockClear();
  stubMatchMedia(false);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Wall Mode requires authentication (R19.4)', () => {
  it('gates /wall behind ProtectedRoute and shows the login screen when unauthenticated', async () => {
    setSession(null);
    setBoardData();
    renderGatedWall();

    // The login screen renders instead of the board.
    expect(
      await screen.findByRole('button', { name: /continue with google/i }),
    ).toBeInTheDocument();
    // The board content is never rendered for an unauthenticated viewer.
    expect(screen.queryByText('Wash the dishes')).not.toBeInTheDocument();
    expect(screen.queryByText('The Testers')).not.toBeInTheDocument();
  });

  it('renders Wall Mode when an authenticated session exists', async () => {
    setSession(AUTHENTICATED_SESSION);
    setBoardData();
    renderGatedWall();

    // Wall renders the family header and the board; the login button is gone.
    expect(await screen.findByText('The Testers')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /continue with google/i }),
    ).not.toBeInTheDocument();
  });
});

describe('Wall Mode landscape board layout (R19.1)', () => {
  function renderAuthedWall() {
    setSession(AUTHENTICATED_SESSION);
    setBoardData();
    return render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={['/wall']}>
          <Wall />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  it('renders a per-member column for each active member', () => {
    renderAuthedWall();

    const ada = screen.getByRole('heading', { name: 'Ada Lovelace' });
    const alan = screen.getByRole('heading', { name: 'Alan Turing' });
    expect(ada).toBeInTheDocument();
    expect(alan).toBeInTheDocument();
  });

  it('renders each day/member task under its owning column', () => {
    renderAuthedWall();

    expect(screen.getByText('Wash the dishes')).toBeInTheDocument();
    expect(screen.getByText('Take out the trash')).toBeInTheDocument();
  });

  it('locks the shell to the viewport height for a landscape mounted display', () => {
    const { container } = renderAuthedWall();
    const shell = container.querySelector('div');
    // The landscape shell fills the screen height and manages its own internal
    // scroll region rather than scrolling the page (R19.1).
    expect(shell).toHaveClass('h-screen');
    expect(shell?.className).toMatch(/flex-col/);
  });
});

describe('Wall Mode reduced-motion handling (R19.3)', () => {
  it('ships a global prefers-reduced-motion rule that neutralizes animation/transition', () => {
    // The suppression is implemented app-wide (and therefore in Wall Mode) via
    // a CSS media query in the global stylesheet. jsdom does not evaluate media
    // queries against computed style, so we assert the real mechanism exists:
    // the stylesheet collapses animation + transition durations under
    // `prefers-reduced-motion: reduce` (R19.3 / R31.4). Read the source file
    // directly (same node:fs pattern used elsewhere in the suite) since Vite's
    // CSS pipeline does not expose index.css as raw text under Vitest.
    // Vitest runs with cwd at the frontend package root, so resolve the global
    // stylesheet from there.
    const cssPath = path.resolve(process.cwd(), 'src/index.css');
    const css = readFileSync(cssPath, 'utf8');
    const block = css
      .slice(css.indexOf('@media (prefers-reduced-motion: reduce)'))
      .slice(0, 400);

    expect(block).toContain('@media (prefers-reduced-motion: reduce)');
    expect(block).toMatch(/animation-duration:\s*0\.01ms\s*!important/);
    expect(block).toMatch(/transition-duration:\s*0\.01ms\s*!important/);
    expect(block).toMatch(/animation-iteration-count:\s*1\s*!important/);
  });

  it('renders the board normally while the device reports reduced motion', () => {
    stubMatchMedia(true);
    setSession(AUTHENTICATED_SESSION);
    setBoardData();

    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={['/wall']}>
          <Wall />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    // Reduced motion must not degrade functionality: the board still renders
    // its members and tasks. The motion suppression itself is OS/CSS driven and
    // not a JS branch Wall takes.
    expect(window.matchMedia('(prefers-reduced-motion: reduce)').matches).toBe(true);
    expect(screen.getByRole('heading', { name: 'Ada Lovelace' })).toBeInTheDocument();
    expect(screen.getByText('Wash the dishes')).toBeInTheDocument();
  });
});

describe('Wall Mode touch targets and focus visibility (R19.2 / R31.1 / R31.3)', () => {
  function renderAuthedWall() {
    setSession(AUTHENTICATED_SESSION);
    setBoardData();
    return render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={['/wall']}>
          <Wall />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  it('gives the complete-task control >=44x44px classes and a visible focus ring', () => {
    renderAuthedWall();

    // Ada's TODO task offers a "Mark done" control.
    const complete = screen.getByRole('button', { name: /mark wash the dishes done/i });
    expect(complete).toHaveClass('min-h-11');
    expect(complete).toHaveClass('min-w-11');
    expect(complete.className).toMatch(/focus-visible:ring-2/);
  });

  it('gives the reopen control (DONE task) >=44x44px classes and a visible focus ring', () => {
    renderAuthedWall();

    // Alan's DONE task offers a "Reopen" control.
    const reopen = screen.getByRole('button', { name: /reopen take out the trash/i });
    expect(reopen).toHaveClass('min-h-11');
    expect(reopen).toHaveClass('min-w-11');
    expect(reopen.className).toMatch(/focus-visible:ring-2/);
  });

  it('gives the exit-wall-mode control >=44x44px classes and a visible focus ring', () => {
    renderAuthedWall();

    const exit = screen.getByRole('link', { name: /exit wall mode/i });
    expect(exit).toHaveClass('min-h-11');
    expect(exit).toHaveClass('min-w-11');
    expect(exit.className).toMatch(/focus-visible:ring-2/);
  });

  it('every interactive control in Wall Mode carries the >=44px target classes', () => {
    const { container } = renderAuthedWall();

    const controls = [
      ...Array.from(container.querySelectorAll('button')),
      ...Array.from(container.querySelectorAll('a')),
    ];
    expect(controls.length).toBeGreaterThan(0);
    for (const el of controls) {
      expect(el.className).toContain('min-h-11');
      expect(el.className).toContain('min-w-11');
    }
  });
});
