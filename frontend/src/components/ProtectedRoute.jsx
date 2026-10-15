import { Navigate, useLocation } from 'react-router-dom';
import { loginPath, accessDestination } from '@/lib/authReturnTo';
import { Outlet } from 'react-router-dom';
import { useAuth } from '@/lib/AuthContext';
export default function ProtectedRoute({
  fallback = <div role="status">Resolving access…</div>,
  unauthenticatedElement,
}) {
  const {
    isAuthenticated,
    isLoadingAuth,
    authChecked,
    access,
    authError,
    logout,
    retryAccessResolution,
  } = useAuth();
  const location = useLocation();
  if (authError && isAuthenticated)
    return <Navigate replace to="/access-error" />;
  if (isLoadingAuth || (!authChecked && !authError)) return fallback;
  if (!isAuthenticated)
    return (
      unauthenticatedElement ?? (
        <Navigate replace to={loginPath(location.pathname + location.search)} />
      )
    );
  if (
    !access ||
    ['NO_ACCESS', 'REVOKED', 'PAYMENT_REQUIRED'].includes(access.state)
  )
    return <Navigate replace to={accessDestination(access)} />;
  if (access.membership?.role === 'MEMBER') {
    if (!access.membership.memberId)
      return (
        <AccessNotice
          title="Could not resolve participant access"
          detail="Retry access resolution or contact your family manager."
        >
          <button onClick={retryAccessResolution}>Retry access</button>
          <button onClick={logout}>Sign out</button>
        </AccessNotice>
      );
    if (!access.capabilities?.includes('member:views'))
      return (
        <AccessNotice
          title="Member views unavailable"
          detail="Your family access is connected. Member views are currently disabled."
        >
          <button onClick={logout}>Sign out</button>
        </AccessNotice>
      );
    const allowed = new Set([
      '/',
      '/board',
      '/leaderboard',
      '/wall',
      '/points-history',
      '/member-profile',
      '/family-awards',
    ]);
    if (!allowed.has(location.pathname))
      return (
        <AccessNotice
          title="Page unavailable for your role"
          detail="You can view your dashboard, shared board and personal history."
        >
          <a href="/">Home</a>
        </AccessNotice>
      );
  }
  if (
    access.state === 'ONBOARDING_REQUIRED' &&
    access.membership?.role !== 'OWNER'
  )
    return (
      <AccessNotice
        title="Waiting for family setup"
        detail="Ask the owner to complete family setup."
      >
        <button onClick={logout}>Sign out</button>
      </AccessNotice>
    );
  return <Outlet />;
}
function AccessNotice({ title, detail, children }) {
  return (
    <main className="max-w-md mx-auto p-8 space-y-4">
      <h1 className="text-xl font-bold">{title}</h1>
      <p>{detail}</p>
      <div className="flex gap-4">{children}</div>
    </main>
  );
}
