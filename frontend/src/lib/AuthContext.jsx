import React, { createContext, useState, useContext, useEffect, useCallback, useRef } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { configureApiClient } from '@/api/client';

// AuthContext — reworked for Supabase Google OAuth (DP-3 / R1.8 / R24.5 / R24.6).
//
// This replaces the previous Base44-based auth. Data access now goes through
// the typed REST client (`@/api/client`), which we wire up here via
// `configureApiClient` so it can:
//   - attach the current Supabase access token as a Bearer header, and
//   - redirect to the Google OAuth login flow on a 401 (R24.5).
//
// The public surface is kept backward compatible so existing pages/components
// (App.jsx, Layout, Settings, modals, ProtectedRoute, Onboarding) keep working
// during the migration. Legacy Base44-only fields are retained as inert
// defaults and will be cleaned up by the auth-page removal task (16.2):
//   - isLoadingPublicSettings: always false (no Base44 app-settings fetch).
//   - appPublicSettings:       always null.
//   - checkAppState:           alias of the Supabase session check.
//
// Added for the Supabase rework:
//   - login() / redirectToLogin(): start Google OAuth.
//   - getAccessToken():            current session access token (or null).

const AuthContext = createContext(null);

// Where Google sends the user back after consenting. supabase-js
// (detectSessionInUrl) parses the session from this URL and fires
// onAuthStateChange. The SPA root handles the rest.
const OAUTH_REDIRECT_PATH = '/';

function mapSessionUser(session) {
  // Normalize the Supabase user into the shape existing components read.
  // Components currently use `user.email`, `user.id`, and display name-ish
  // fields; expose the raw Supabase user plus a couple of convenience fields.
  const u = session?.user ?? null;
  if (!u) return null;
  return {
    ...u,
    // Convenience fields that mirror common Base44 user props so UI code that
    // reads `full_name` / `email` keeps rendering.
    email: u.email ?? u.user_metadata?.email ?? null,
    full_name:
      u.user_metadata?.full_name ??
      u.user_metadata?.name ??
      u.email ??
      null,
  };
}

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoadingAuth, setIsLoadingAuth] = useState(true);
  const [authError, setAuthError] = useState(null);
  const [authChecked, setAuthChecked] = useState(false);

  // Guard so we only wire the REST client once per provider instance.
  const configuredRef = useRef(false);

  const applySession = useCallback((session) => {
    const mapped = mapSessionUser(session);
    setUser(mapped);
    setIsAuthenticated(!!session);
    setIsLoadingAuth(false);
    setAuthChecked(true);
  }, []);

  // Return the current access token (or null). Used by the REST client to
  // attach the Bearer header on every request.
  const getAccessToken = useCallback(async () => {
    try {
      const { data } = await supabase.auth.getSession();
      return data.session?.access_token ?? null;
    } catch (error) {
      console.error('[AuthContext] getAccessToken failed:', error);
      return null;
    }
  }, []);

  // Start the Google OAuth sign-in flow. Named `redirectToLogin` to match the
  // REST client's 401 handler; `login` is an alias for call sites that read
  // more naturally.
  const redirectToLogin = useCallback(async () => {
    setAuthError(null);
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: window.location.origin + OAUTH_REDIRECT_PATH,
      },
    });
    if (error) {
      console.error('[AuthContext] signInWithOAuth failed:', error);
      setAuthError({ type: 'auth_required', message: error.message });
    }
  }, []);

  const login = redirectToLogin;

  // Sign out and clear local auth state. `shouldRedirect` kept for signature
  // compatibility with the previous Base44 logout; after sign-out we send the
  // user back to the OAuth login flow when asked.
  const logout = useCallback(
    async (shouldRedirect = true) => {
      try {
        await supabase.auth.signOut();
      } catch (error) {
        console.error('[AuthContext] signOut failed:', error);
      }
      setUser(null);
      setIsAuthenticated(false);
      setAuthChecked(true);
      setIsLoadingAuth(false);
      if (shouldRedirect) {
        redirectToLogin();
      }
    },
    [redirectToLogin],
  );

  // Re-check the current session on demand. Kept as `checkUserAuth` (and
  // aliased as `checkAppState`) so existing callers (ProtectedRoute, App) still
  // work without changes.
  const checkUserAuth = useCallback(async () => {
    setIsLoadingAuth(true);
    try {
      const { data, error } = await supabase.auth.getSession();
      if (error) throw error;
      applySession(data.session);
    } catch (error) {
      console.error('[AuthContext] session check failed:', error);
      setUser(null);
      setIsAuthenticated(false);
      setIsLoadingAuth(false);
      setAuthChecked(true);
    }
  }, [applySession]);

  const checkAppState = checkUserAuth;

  // Wire the REST client to this context's token provider + 401 handler, once.
  // Done in an effect so it runs on mount (and if the callbacks' identity is
  // stable, not repeatedly).
  useEffect(() => {
    if (configuredRef.current) return;
    configuredRef.current = true;
    configureApiClient({
      getAccessToken,
      onUnauthorized: redirectToLogin,
    });
  }, [getAccessToken, redirectToLogin]);

  // Restore the session on mount and subscribe to auth state changes so
  // user/isAuthenticated stay reactive (login completion, token refresh,
  // sign-out from another tab). Unsubscribe on unmount.
  useEffect(() => {
    let active = true;

    supabase.auth
      .getSession()
      .then(({ data }) => {
        if (!active) return;
        applySession(data.session);
      })
      .catch((error) => {
        if (!active) return;
        console.error('[AuthContext] initial getSession failed:', error);
        setUser(null);
        setIsAuthenticated(false);
        setIsLoadingAuth(false);
        setAuthChecked(true);
      });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!active) return;
      applySession(session);
    });

    return () => {
      active = false;
      subscription?.unsubscribe();
    };
  }, [applySession]);

  return (
    <AuthContext.Provider
      value={{
        // Core reactive auth state
        user,
        isAuthenticated,
        isLoadingAuth,
        authError,
        authChecked,

        // Actions
        login,
        redirectToLogin,
        logout,
        getAccessToken,
        checkUserAuth,
        checkAppState,

        // Legacy Base44-era fields kept inert for backward compatibility.
        // Removed/cleaned up by the auth-page removal task (16.2).
        isLoadingPublicSettings: false,
        appPublicSettings: null,
        navigateToLogin: redirectToLogin,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
