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
    retryAccessResolution,
    logout,
  } = useAuth();
  if (isLoadingAuth || !authChecked) return fallback;
  if (!isAuthenticated) return unauthenticatedElement;
  if (authError)
    return (
      <AccessNotice
        title="Could not resolve family access"
        detail={authError.message}
      >
        <button onClick={retryAccessResolution}>Retry</button>
        <button onClick={logout}>Sign out</button>
      </AccessNotice>
    );
  if (!access || ['NO_ACCESS', 'REVOKED'].includes(access.state))
    return (
      <AccessNotice
        title={
          access?.state === 'REVOKED'
            ? 'Family access revoked'
            : 'No family access'
        }
        detail="Ask your family manager to enable access for your verified email."
      >
        <button onClick={logout}>Sign out</button>
      </AccessNotice>
    );
  if (access.membership?.role === 'MEMBER')
    return (
      <AccessNotice
        title="Family access connected"
        detail="Your member dashboard will be available with the member experience feature."
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
