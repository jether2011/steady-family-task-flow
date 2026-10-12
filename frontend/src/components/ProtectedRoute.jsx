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
  if (
    access.membership?.role === 'MEMBER' &&
    accessDestination(access, location.pathname + location.search) !==
      location.pathname + location.search
  )
    return (
      <Navigate
        replace
        to={accessDestination(access, location.pathname + location.search)}
      />
    );
  if (access.membership?.role === 'MEMBER')
    return (
      <AccessNotice
        title="Family access connected"
        detail={
          new URLSearchParams(location.search).get('accessMessage') === 'member'
            ? 'Your role does not allow that page. You were returned to home. Your member dashboard will be available with the member experience feature.'
            : 'Your member dashboard will be available with the member experience feature.'
        }
      >
        <button onClick={logout}>Sign out</button>
      </AccessNotice>
    );
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
