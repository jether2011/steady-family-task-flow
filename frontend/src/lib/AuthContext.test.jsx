import React from 'react';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

// ---------------------------------------------------------------------------
// Mocks
//
// Task 16.3: authenticated login-state test. We mock the Supabase browser
// client so we can drive the session state (signed out vs. authenticated) and
// assert that clicking "Continue with Google" starts the OAuth sign-in. The
// REST client's configureApiClient is stubbed so the AuthProvider mount effect
// is inert and nothing touches the network.
// ---------------------------------------------------------------------------

// Hoisted mock state. `vi.hoisted` runs before the vi.mock factory, so the
// factory (also hoisted) can safely reference these without the
// "cannot access before initialization" error.
const mockState = vi.hoisted(() => ({
  // Mutable "current session" the mock getSession resolves with. Tests set this
  // via setSession() before rendering.
  currentSession: null,
  callback: null,
}));

vi.mock('@/lib/supabaseClient', () => {
  const auth = {
    getSession: vi.fn(async () => ({
      data: { session: mockState.currentSession },
      error: null,
    })),
    onAuthStateChange: vi.fn((callback) => {
      mockState.callback = callback;
      return { data: { subscription: { unsubscribe: vi.fn() } } };
    }),
    signInWithOAuth: vi.fn(async () => ({ data: {}, error: null })),
    signOut: vi.fn(async () => ({ error: null })),
    verifyOtp: vi.fn(),
    signInWithOtp: vi.fn(),
  };
  const supabase = { auth };
  return { supabase, default: supabase };
});

vi.mock('@/api/client', () => ({
  configureApiClient: vi.fn(),
}));

// The AuthProvider bootstraps the backend family rows via GET /me as soon as a
// session exists (the backend creates responsible_user + family only there).
// Mock the family api so we can assert that bootstrap happens and keep the test
// off the network.
const meMock = vi.hoisted(() =>
  vi.fn(async () => ({
    family: {
      id: 'fam-1',
      name: 'My Family',
      relationship: null,
      responsible_name: null,
    },
    state: 'READY',
    user: { id: 'app-1', displayName: 'Parent', avatarUrl: null },
    membership: {
      id: 'membership-1',
      role: 'OWNER',
      memberId: null,
      accessVersion: 1,
    },
    capabilities: ['family:manage'],
  })),
);
vi.mock('@/api/family.api', () => ({
  family: { me: meMock, get: vi.fn(), update: vi.fn() },
}));

// Imported after the mocks are registered.
import { configureApiClient } from '@/api/client';
import { queryClientInstance } from '@/lib/query-client';
import { supabase } from '@/lib/supabaseClient';
import { AuthProvider, useAuth } from '@/lib/AuthContext';
import ProtectedRoute from '@/components/ProtectedRoute';
import Login from '@/pages/Login';

const signInWithOAuth = supabase.auth.signInWithOAuth;
const signOut = supabase.auth.signOut;

function setSession(session) {
  mockState.currentSession = session;
}

const AUTHENTICATED_SESSION = {
  access_token: 'test-access-token',
  user: {
    id: 'user-123',
    email: 'parent@example.com',
    user_metadata: { full_name: 'Test Parent' },
  },
};

beforeEach(() => {
  meMock.mockClear();
  mockState.currentSession = null;
  signInWithOAuth.mockClear();
  signOut.mockClear();
});

describe('Login screen (R1.8)', () => {
  it('renders the single "Continue with Google" button', async () => {
    setSession(null);
    render(
      <AuthProvider>
        <MemoryRouter>
          <Login />
        </MemoryRouter>
      </AuthProvider>,
    );

    const button = await screen.findByRole('button', {
      name: /continue with google/i,
    });
    expect(button).toBeInTheDocument();
  });

  it('starts the Google OAuth sign-in when the button is clicked', async () => {
    setSession(null);
    const user = userEvent.setup();
    render(
      <AuthProvider>
        <MemoryRouter>
          <Login />
        </MemoryRouter>
      </AuthProvider>,
    );

    const button = await screen.findByRole('button', {
      name: /continue with google/i,
    });
    await user.click(button);

    await waitFor(() => {
      expect(signInWithOAuth).toHaveBeenCalledTimes(1);
    });
    expect(signInWithOAuth).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'google' }),
    );
  });
});

describe('ProtectedRoute gating (R1.8 / R24.5)', () => {
  const Protected = () => (
    <Routes>
      <Route
        element={
          <ProtectedRoute
            fallback={<div>Loading...</div>}
            unauthenticatedElement={<Login />}
          />
        }
      >
        <Route path="/" element={<div>Protected content</div>} />
      </Route>
    </Routes>
  );

  it('blocks protected content and shows the login screen when there is no session', async () => {
    setSession(null);
    render(
      <AuthProvider>
        <MemoryRouter initialEntries={['/']}>
          <Protected />
        </MemoryRouter>
      </AuthProvider>,
    );

    expect(
      await screen.findByRole('button', { name: /continue with google/i }),
    ).toBeInTheDocument();
    expect(screen.queryByText('Protected content')).not.toBeInTheDocument();
  });

  it('renders protected content when an authenticated session exists', async () => {
    setSession(AUTHENTICATED_SESSION);
    render(
      <AuthProvider>
        <MemoryRouter initialEntries={['/']}>
          <Protected />
        </MemoryRouter>
      </AuthProvider>,
    );

    expect(await screen.findByText('Protected content')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /continue with google/i }),
    ).not.toBeInTheDocument();
  });

  it('resolves backend membership via GET /me once a session exists', async () => {
    // Regression: PATCH /family returned 404 because the frontend never called
    // GET /me, so the backend never created the responsible_user + family rows.
    // The AuthProvider must bootstrap /me when authenticated.
    setSession(AUTHENTICATED_SESSION);
    render(
      <AuthProvider>
        <MemoryRouter initialEntries={['/']}>
          <Protected />
        </MemoryRouter>
      </AuthProvider>,
    );

    await waitFor(() => expect(meMock).toHaveBeenCalled());
  });

  it('does NOT call GET /me when there is no session', async () => {
    setSession(null);
    render(
      <AuthProvider>
        <MemoryRouter initialEntries={['/']}>
          <Protected />
        </MemoryRouter>
      </AuthProvider>,
    );

    await screen.findByRole('button', { name: /continue with google/i });
    expect(meMock).not.toHaveBeenCalled();
  });

  it('exposes the authenticated user from the restored session', async () => {
    setSession(AUTHENTICATED_SESSION);
    let authValue = null;
    const Probe = () => {
      authValue = useAuth();
      return null;
    };

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(authValue?.isAuthenticated).toBe(true);
    });
    expect(authValue.user?.email).toBe('parent@example.com');
    expect(await authValue.getAccessToken()).toBe('test-access-token');
  });
});

describe('membership resolution lifecycle', () => {
  it('does not restore delayed family resolution after logout', async () => {
    setSession(AUTHENTICATED_SESSION);
    let finish;
    meMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    let value;
    function Probe() {
      value = useAuth();
      return null;
    }
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => expect(finish).toBeDefined());
    await act(async () => {
      await value.logout();
    });
    await act(async () => {
      finish({
        state: 'READY',
        family: { id: 'old-family' },
        membership: { role: 'OWNER', accessVersion: 1 },
      });
    });
    expect(value.user).toBeNull();
    expect(value.access).toBeNull();
    expect(value.isAuthenticated).toBe(false);
  });
  it('exposes NO_ACCESS without starting another OAuth redirect', async () => {
    setSession(AUTHENTICATED_SESSION);
    meMock.mockResolvedValueOnce({
      state: 'NO_ACCESS',
      user: { id: 'app-1' },
      family: null,
      membership: null,
      capabilities: [],
    });
    render(
      <AuthProvider>
        <MemoryRouter>
          <Routes>
            <Route path="/no-access" element={<div>No family access</div>} />
            <Route element={<ProtectedRoute />}>
              <Route path="/" element={<div>Protected content</div>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </AuthProvider>,
    );
    expect(await screen.findByText('No family access')).toBeInTheDocument();
    expect(signInWithOAuth).not.toHaveBeenCalled();
    expect(screen.queryByText('Protected content')).not.toBeInTheDocument();
  });
});

describe('email session integration', () => {
  it('resolves membership after OTP verification', async () => {
    setSession(null);
    let value;
    const Probe = () => {
      value = useAuth();
      return null;
    };
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => expect(value.authChecked).toBe(true));
    supabase.auth.verifyOtp.mockResolvedValueOnce({
      data: { session: AUTHENTICATED_SESSION },
      error: null,
    });
    await act(async () => {
      await value.verifyEmailCode('parent@example.com', '123456');
    });
    expect(value.access.membership.role).toBe('OWNER');
    expect(meMock).toHaveBeenCalledTimes(1);
  });
  it('ignores a late verification after logout', async () => {
    setSession(null);
    let value, complete;
    const Probe = () => {
      value = useAuth();
      return null;
    };
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => expect(value.authChecked).toBe(true));
    supabase.auth.verifyOtp.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    let outcome;
    await act(async () => {
      outcome = value
        .verifyEmailCode('parent@example.com', '123456')
        .catch((error) => error);
    });
    await act(async () => {
      await value.logout();
      complete({ data: { session: AUTHENTICATED_SESSION }, error: null });
      await outcome;
    });
    expect(value.user).toBeNull();
    expect(value.access).toBeNull();
    expect(meMock).not.toHaveBeenCalled();
    expect(signInWithOAuth).not.toHaveBeenCalled();
  });
  it('blocks family access and gives a safe recovery message on identity conflict', async () => {
    setSession(AUTHENTICATED_SESSION);
    meMock.mockRejectedValueOnce(
      Object.assign(new Error('private household data'), {
        code: 'ACCESS_CONFLICT',
      }),
    );
    let value;
    const Probe = () => {
      value = useAuth();
      return null;
    };
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => expect(value.authError?.code).toBe('ACCESS_CONFLICT'));
    expect(value.authChecked).toBe(false);
    expect(value.access).toBeNull();
    expect(value.authError.message).toContain('previous sign-in method');
    expect(value.authError.message).not.toContain('private household');
  });
});

describe('session transitions', () => {
  it('deduplicates provider events while resolving the same session', async () => {
    setSession(AUTHENTICATED_SESSION);
    let finish, value;
    meMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const Probe = () => {
      value = useAuth();
      return null;
    };
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => expect(finish).toBeDefined());
    await act(async () => {
      mockState.callback('TOKEN_REFRESHED', AUTHENTICATED_SESSION);
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    expect(meMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish({
        state: 'READY',
        family: { id: 'family' },
        membership: { role: 'OWNER', accessVersion: 1 },
      });
    });
    expect(value.access.family.id).toBe('family');
  });
  it('rejects a late old-account resolution after a new account arrives', async () => {
    setSession(AUTHENTICATED_SESSION);
    let finish, value;
    meMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    meMock.mockResolvedValueOnce({
      state: 'READY',
      family: { id: 'new-family' },
      membership: { role: 'MANAGER', accessVersion: 1 },
    });
    const Probe = () => {
      value = useAuth();
      return null;
    };
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => expect(finish).toBeDefined());
    const next = {
      ...AUTHENTICATED_SESSION,
      user: { ...AUTHENTICATED_SESSION.user, id: 'new-subject' },
    };
    setSession(next);
    await act(async () => {
      mockState.callback('SIGNED_IN', next);
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    await waitFor(() => expect(value.access?.family.id).toBe('new-family'));
    await act(async () => {
      finish({
        state: 'READY',
        family: { id: 'old-family' },
        membership: { role: 'OWNER', accessVersion: 1 },
      });
    });
    expect(value.user.id).toBe('new-subject');
    expect(value.access.family.id).toBe('new-family');
  });
  it('clears private cache and handles parallel 401 callbacks without OAuth', async () => {
    setSession(AUTHENTICATED_SESSION);
    let value;
    const Probe = () => {
      value = useAuth();
      return null;
    };
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => expect(value.access).not.toBeNull());
    queryClientInstance.setQueryData(['private-family-data'], {
      private: true,
    });
    const config = configureApiClient.mock.calls.at(-1)[0];
    await act(async () => {
      config.onUnauthorized();
      config.onUnauthorized();
    });
    expect(value.access).toBeNull();
    expect(value.user).toBeNull();
    expect(
      queryClientInstance.getQueryData(['private-family-data']),
    ).toBeUndefined();
    expect(signInWithOAuth).not.toHaveBeenCalled();
    expect(signOut).toHaveBeenCalledTimes(1);
  });
});

describe('removed email/password + consent pages are gone (R1.8)', () => {
  const removedPages = [
    'Register',
    'ForgotPassword',
    'ResetPassword',
    'OAuthConsent',
  ];

  it.each(removedPages)('src/pages/%s.jsx does not exist', (page) => {
    const path = fileURLToPath(
      new URL(`../pages/${page}.jsx`, import.meta.url),
    );
    expect(existsSync(path)).toBe(false);
  });

  it('App.jsx wires no routes for the removed pages', async () => {
    const appSource = await import('@/App.jsx?raw').then((m) => m.default);
    for (const page of removedPages) {
      expect(appSource).not.toContain(`pages/${page}`);
    }
    // No email/password or password-reset route paths remain.
    expect(appSource).not.toMatch(/path=["']\/register["']/);
    expect(appSource).not.toMatch(/path=["']\/forgot-password["']/);
    expect(appSource).not.toMatch(/path=["']\/reset-password["']/);
    expect(appSource).not.toMatch(/path=["']\/oauth-consent["']/);
  });
});
