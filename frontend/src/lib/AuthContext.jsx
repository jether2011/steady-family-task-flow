import React, {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useCallback,
} from 'react';
import { supabase } from '@/lib/supabaseClient';
import { configureApiClient } from '@/api/client';
import { family as familyApi } from '@/api/family.api';
import { queryClientInstance } from '@/lib/query-client';
const AuthContext = createContext(null);
export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [access, setAccess] = useState(null);
  const [isLoadingAuth, setLoading] = useState(true);
  const [authError, setError] = useState(null);
  const generation = useRef(0),
    scope = useRef(null),
    mounted = useRef(true),
    sessionUser = useRef(null);
  const clearScope = useCallback(async () => {
    await queryClientInstance.cancelQueries();
    queryClientInstance.clear();
    scope.current = null;
  }, []);
  const resolve = useCallback(
    async (session, { background = false } = {}) => {
      if (!mounted.current) return;
      const turn = ++generation.current;
      if (!background) {
        setLoading(true);
        setAccess(null);
      }
      if (sessionUser.current !== session?.user?.id) {
        setAccess(null);
        await clearScope();
      }
      if (!mounted.current || turn !== generation.current) return;
      sessionUser.current = session?.user?.id ?? null;
      setUser(
        session?.user
          ? {
              ...session.user,
              full_name: session.user.user_metadata?.name ?? session.user.email,
            }
          : null,
      );
      if (!session?.user) {
        setAccess(null);
        setError(null);
        setLoading(false);
        return;
      }
      try {
        const next = await familyApi.me();
        if (!mounted.current || turn !== generation.current) return;
        const key = JSON.stringify([
          session.user.id,
          next.family?.id,
          next.membership?.role,
          next.membership?.accessVersion,
          next.state,
        ]);
        if (scope.current !== key) {
          setAccess(null);
          await clearScope();
          if (turn !== generation.current) return;
          scope.current = key;
        }
        setAccess(next);
        setError(null);
      } catch (error) {
        if (turn === generation.current) {
          setAccess(null);
          await clearScope();
          if (turn === generation.current)
            setError({
              message: error.message || 'Could not resolve family access',
            });
        }
      } finally {
        if (mounted.current && turn === generation.current) setLoading(false);
      }
    },
    [clearScope],
  );
  const retryAccessResolution = useCallback(async () => {
    const { data } = await supabase.auth.getSession();
    await resolve(data.session);
  }, [resolve]);
  const getAccessToken = useCallback(async () => {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? null;
  }, []);
  const redirectToLogin = useCallback(() => {
    generation.current++;
    sessionUser.current = null;
    setUser(null);
    setAccess(null);
    setLoading(false);
    void clearScope();
  }, [clearScope]);
  const login = useCallback(async () => {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo:
          window.location.origin +
          (window.location.pathname === '/access-email-confirm'
            ? window.location.pathname + window.location.search
            : '/'),
      },
    });
    if (error)
      setError({ message: 'Sign-in could not be started. Please try again.' });
  }, []);
  const logout = useCallback(async () => {
    redirectToLogin();
    try {
      await supabase.auth.signOut();
    } catch {
      setError({ message: 'Remote sign-out failed. Please try again.' });
    }
  }, [redirectToLogin]);
  useEffect(() => {
    mounted.current = true;
    configureApiClient({ getAccessToken, onUnauthorized: redirectToLogin });
    const restore = () => {
      const started = generation.current;
      return supabase.auth
        .getSession()
        .then(({ data }) => {
          if (mounted.current && generation.current === started)
            return resolve(data.session, { background: true });
        })
        .catch(() => {
          if (!mounted.current || generation.current !== started) return;
          generation.current++;
          setAccess(null);
          void clearScope();
          setLoading(false);
          setError({ message: 'Could not restore your session' });
        });
    };
    void restore();
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      // Provider callbacks must return before performing session-dependent REST work.
      setTimeout(() => {
        if (mounted.current) void resolve(session);
      }, 0);
    });
    const timer = setInterval(() => {
      if (sessionUser.current) void restore();
    }, 30000);
    const focus = () => {
      if (sessionUser.current) void restore();
    };
    window.addEventListener('focus', focus);
    return () => {
      mounted.current = false;
      generation.current++;
      subscription.unsubscribe();
      clearInterval(timer);
      window.removeEventListener('focus', focus);
    };
  }, [resolve, getAccessToken, redirectToLogin, clearScope]);
  return (
    <AuthContext.Provider
      value={{
        user,
        access,
        isAuthenticated: !!user,
        isLoadingAuth,
        authChecked: !isLoadingAuth,
        authError,
        login,
        redirectToLogin,
        logout,
        getAccessToken,
        retryAccessResolution,
        checkUserAuth: retryAccessResolution,
        checkAppState: retryAccessResolution,
        navigateToLogin: redirectToLogin,
        isLoadingPublicSettings: false,
        appPublicSettings: null,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};
export const useAuth = () => {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used within an AuthProvider');
  return value;
};
