import { lazy, Suspense } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '@/lib/AuthContext';
import { accessDestination } from '@/lib/authReturnTo';
import AccessStatus from '@/pages/AccessStatus';
const Billing = lazy(() => import('@/pages/Billing'));
export default function BillingRoute() {
  const auth = useAuth();
  if (auth.isLoadingAuth || (!auth.authChecked && !auth.authError))
    return (
      <main role="status" className="p-8">
        Resolving billing access…
      </main>
    );
  if (auth.authError) return <Navigate replace to="/access-error" />;
  if (!auth.isAuthenticated) return <Navigate replace to="/login" />;
  if (auth.access?.state === 'ONBOARDING_REQUIRED')
    return <Navigate replace to={accessDestination(auth.access)} />;
  if (auth.access?.membership?.role !== 'OWNER') return <AccessStatus />;
  if (!['READY', 'PAYMENT_REQUIRED'].includes(auth.access.state))
    return <Navigate replace to={accessDestination(auth.access)} />;
  return (
    <Suspense
      fallback={
        <main role="status" className="p-8">
          Loading billing…
        </main>
      }
    >
      <Billing />
    </Suspense>
  );
}
