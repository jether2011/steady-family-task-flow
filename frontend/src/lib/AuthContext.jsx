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
import {
  requestCode,
  verifyCode,
  resolutionMessage,
  emailOtpEnabled,
} from '@/lib/authProvider';
import { loginPath, safeReturnTo } from '@/lib/authReturnTo';
const AuthContext = createContext(null);
export const useOptionalAuth = () => useContext(AuthContext);
function showLogin() {
  if (window.location.pathname === '/login') return;
  window.history.replaceState(
    {},
    '',
    loginPath(window.location.pathname + window.location.search),
  );
  window.dispatchEvent(new PopStateEvent('popstate'));
}
export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null),
    [access, setAccess] = useState(null),
    [isLoadingAuth, setLoading] = useState(true),
    [authError, setError] = useState(null),
    [authChecked, setChecked] = useState(false);
  const generation = useRef(0),
    intent = useRef(0),
    scope = useRef(null),
    mounted = useRef(true),
    sessionUser = useRef(null),
    pending = useRef(null),
    locked = useRef(false),
    verification = useRef(null),
    revocationRefresh = useRef(false);
  const clearScope = useCallback(async () => {
    await queryClientInstance.cancelQueries();
    queryClientInstance.clear();
    scope.current = null;
  }, []);
  const resolve = useCallback(
    (session, { background = false } = {}) => {
      if (!mounted.current || (locked.current && session?.user))
        return Promise.resolve();
      const key = session?.user?.id ?? null;
      if (pending.current?.key === key) return pending.current.promise;
      pending.current?.controller.abort();
      const controller = new AbortController(),
        turn = ++generation.current;
      const work = (async () => {
        if (!background || sessionUser.current !== key) {
          setLoading(true);
          setChecked(false);
          setAccess(null);
        }
        if (sessionUser.current !== key) {
          setAccess(null);
          await clearScope();
        }
        if (!mounted.current || turn !== generation.current) return;
        sessionUser.current = key;
        setUser(
          session?.user
            ? {
                ...session.user,
                full_name:
                  session.user.user_metadata?.name ?? session.user.email,
              }
            : null,
        );
        if (!session?.user) {
          setAccess(null);
          setError(null);
          setChecked(true);
          setLoading(false);
          return;
        }
        try {
          const next = await familyApi.me(controller.signal);
          if (!mounted.current || turn !== generation.current) return;
          const nextScope = JSON.stringify([
            key,
            next.family?.id,
            next.membership?.role,
            next.membership?.accessVersion,
            next.access?.version,
            next.state,
          ]);
          if (scope.current !== nextScope) {
            setAccess(null);
            await clearScope();
            if (!mounted.current || turn !== generation.current) return;
            scope.current = nextScope;
          }
          setAccess(next);
          setError(null);
          setChecked(true);
        } catch (error) {
          if (
            !mounted.current ||
            turn !== generation.current ||
            controller.signal.aborted
          )
            return;
          setAccess(null);
          setChecked(false);
          await clearScope();
          if (mounted.current && turn === generation.current)
            setError({ code: error.code, message: resolutionMessage(error) });
        } finally {
          if (mounted.current && turn === generation.current) setLoading(false);
        }
      })();
      pending.current = { key, controller, promise: work };
      void work.finally(() => {
        if (pending.current?.promise === work) pending.current = null;
      });
      return work;
    },
    [clearScope],
  );
  const resetLocal = useCallback(
    (navigate = true) => {
      locked.current = true;
      generation.current++;
      intent.current++;
      sessionUser.current = null;
      pending.current?.controller.abort();
      pending.current = null;
      setUser(null);
      setAccess(null);
      setError(null);
      setChecked(true);
      setLoading(false);
      void clearScope();
      if (navigate) showLogin();
    },
    [clearScope],
  );
  const redirectToLogin = useCallback(() => {
    if (locked.current) return;
    resetLocal();
    void supabase.auth.signOut({ scope: 'local' }).catch(() => {});
  }, [resetLocal]);
  const retryAccessResolution = useCallback(async () => {
    const started = generation.current;
    try {
      const { data, error } = await supabase.auth.getSession();
      if (error) throw error;
      if (started === generation.current) await resolve(data.session);
    } catch {
      if (mounted.current && started === generation.current) {
        setAccess(null);
        setChecked(false);
        setError({ message: resolutionMessage() });
        setLoading(false);
      }
    }
  }, [resolve]);
  const getAccessToken = useCallback(async () => {
    if (locked.current) return null;
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? null;
  }, []);
  const loginWithGoogle = useCallback(async (returnTo = '/') => {
    locked.current = false;
    intent.current++;
    setError(null);
    const path =
      window.location.pathname === '/access-email-confirm'
        ? window.location.pathname + window.location.search
        : loginPath(safeReturnTo(returnTo));
    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: window.location.origin + path },
      });
      if (error) throw error;
    } catch {
      throw new Error('Could not start Google sign-in. Please try again.');
    }
  }, []);
  const requestEmailCode = useCallback(
    (email, captchaToken) => requestCode(email, captchaToken),
    [],
  );
  const cancelEmailSignIn = useCallback(() => {
    intent.current++;
    if (verification.current) locked.current = true;
  }, []);
  const verifyEmailCode = useCallback(
    async (email, code) => {
      if (verification.current)
        throw new Error('Verification is already in progress.');
      const attempt = ++intent.current;
      locked.current = false;
      verification.current = attempt;
      try {
        const session = await verifyCode(email, code);
        if (attempt !== intent.current || !mounted.current) {
          locked.current = true;
          await supabase.auth.signOut({ scope: 'local' });
          throw new Error('Sign-in was cancelled. Please try again.');
        }
        await resolve(session);
      } finally {
        if (verification.current === attempt) verification.current = null;
      }
    },
    [resolve],
  );
  const logout = useCallback(async () => {
    resetLocal();
    try {
      const { error } = await supabase.auth.signOut();
      if (error) throw error;
    } catch {
      setError({
        message:
          'Remote sign-out failed. Local access has been cleared; please retry sign-out.',
      });
    }
  }, [resetLocal]);
  useEffect(() => {
    mounted.current = true;
    const onAccessRevoked = () => {
      if (revocationRefresh.current) return;
      revocationRefresh.current = true;
      generation.current++;
      pending.current?.controller.abort();
      pending.current = null;
      setAccess(null);
      setChecked(false);
      void clearScope()
        .then(() => retryAccessResolution())
        .finally(() => {
          revocationRefresh.current = false;
        });
    };
    configureApiClient({
      getAccessToken,
      onUnauthorized: redirectToLogin,
      onAccessRevoked,
    });
    const restore = () => {
      const started = generation.current;
      return supabase.auth
        .getSession()
        .then(({ data, error }) => {
          if (error) throw error;
          if (
            mounted.current &&
            started === generation.current &&
            !locked.current
          )
            return resolve(data.session, { background: true });
        })
        .catch(() => {
          if (mounted.current && started === generation.current) {
            setAccess(null);
            setChecked(false);
            setLoading(false);
            setError({ message: resolutionMessage() });
            void clearScope();
          }
        });
    };
    void restore();
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      // verifyOtp resolves its own response; synchronous callbacks never await provider work.
      if (verification.current && event === 'SIGNED_IN') return;
      const eventIntent = intent.current;
      if (event === 'SIGNED_OUT') {
        resetLocal(false);
        return;
      }
      setTimeout(() => {
        if (
          mounted.current &&
          eventIntent === intent.current &&
          !locked.current
        )
          void resolve(session);
      }, 0);
    });
    const timer = setInterval(() => {
      if (sessionUser.current && !locked.current) void restore();
    }, 30000);
    const focus = () => {
      if (sessionUser.current && !locked.current) void restore();
    };
    window.addEventListener('focus', focus);
    return () => {
      mounted.current = false;
      generation.current++;
      pending.current?.controller.abort();
      pending.current = null;
      subscription.unsubscribe();
      clearInterval(timer);
      window.removeEventListener('focus', focus);
    };
  }, [
    resolve,
    getAccessToken,
    redirectToLogin,
    clearScope,
    retryAccessResolution,
    resetLocal,
  ]);
  return (
    <AuthContext.Provider
      value={{
        user,
        access,
        isAuthenticated: !!user,
        isLoadingAuth,
        authChecked,
        authError,
        emailOtpEnabled,
        loginWithGoogle,
        requestEmailCode,
        verifyEmailCode,
        cancelEmailSignIn,
        login: loginWithGoogle,
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
