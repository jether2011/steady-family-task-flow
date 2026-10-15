import { Link, Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '@/lib/AuthContext';
import { accessDestination, loginPath } from '@/lib/authReturnTo';
export default function AccessStatus() {
  const auth = useAuth(),
    location = useLocation();
  if (!auth.isAuthenticated) return <Navigate replace to={loginPath('/')} />;
  if (auth.isLoadingAuth)
    return (
      <main className="p-8" role="status">
        Resolving family access…
      </main>
    );
  const target = accessDestination(auth.access);
  if (
    !auth.authError &&
    auth.access &&
    target !== location.pathname &&
    location.pathname !== '/access-error'
  )
    return <Navigate replace to={target} />;
  if (!auth.authError && auth.access && location.pathname === '/access-error')
    return <Navigate replace to={target} />;
  const state = auth.access?.state;
  const title = auth.authError
    ? 'Could not resolve family access'
    : state === 'REVOKED'
      ? 'Family access revoked'
      : state === 'PAYMENT_REQUIRED'
        ? 'Subscription required'
        : state === 'ONBOARDING_REQUIRED'
          ? 'Waiting for family setup'
          : 'No family access';
  const detail =
    auth.authError?.message ??
    (state === 'PAYMENT_REQUIRED'
      ? auth.access?.membership?.role === 'OWNER'
        ? 'Subscriptions are not available yet. Your family draft is saved; return here to continue when subscriptions open.'
        : 'Ask the family owner to activate a subscription.'
      : state === 'ONBOARDING_REQUIRED'
        ? 'Ask the family owner to complete the family profile.'
        : 'Ask your family manager to enable access for your verified email.');
  return (
    <main className="max-w-md mx-auto p-8 space-y-4">
      <h1 className="text-xl font-bold">{title}</h1>
      <p>{detail}</p>
      {state === 'NO_ACCESS' && auth.access?.signupAvailable && (
        <Link to="/create-family">Create a family</Link>
      )}
      <div className="flex gap-4">
        <button onClick={auth.retryAccessResolution}>Retry access</button>
        <button onClick={auth.logout}>Change account</button>
      </div>
    </main>
  );
}
