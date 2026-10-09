import React from 'react';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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

// Imported after the mocks are registered.
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
  mockState.currentSession = null;
  signInWithOAuth.mockClear();
  signOut.mockClear();
});

describe('Login screen (R1.8)', () => {
  it('renders the single "Continue with Google" button', async () => {
    setSession(null);
    render(
      <AuthProvider>
        <Login />
      </AuthProvider>,
    );

    const button = await screen.findByRole('button', { name: /continue with google/i });
    expect(button).toBeInTheDocument();
  });

  it('starts the Google OAuth sign-in when the button is clicked', async () => {
    setSession(null);
    const user = userEvent.setup();
    render(
      <AuthProvider>
        <Login />
      </AuthProvider>,
    );

    const button = await screen.findByRole('button', { name: /continue with google/i });
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

describe('removed email/password + consent pages are gone (R1.8)', () => {
  const removedPages = ['Register', 'ForgotPassword', 'ResetPassword', 'OAuthConsent'];

  it.each(removedPages)('src/pages/%s.jsx does not exist', (page) => {
    const path = fileURLToPath(new URL(`../pages/${page}.jsx`, import.meta.url));
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
