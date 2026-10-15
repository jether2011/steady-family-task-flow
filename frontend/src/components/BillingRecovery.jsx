import { lazy, Suspense } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/lib/AuthContext';
import { billing } from '@/api/billing.api';
const Billing = lazy(() => import('@/pages/Billing'));
/** Re-resolve ownership on the server when /me cannot load its projection. */
export default function BillingRecovery() {
  const auth = useAuth();
  const owner = useQuery({
    queryKey: ['billing-recovery-owner', auth.user?.id],
    queryFn: ({ signal }) => billing.subscription(signal),
    retry: false,
  });
  if (owner.isPending)
    return (
      <main role="status" className="p-8">
        Resolving owner billing recovery…
      </main>
    );
  if (owner.error)
    return (
      <main className="p-8 space-y-4">
        <p role="alert">
          {owner.error.status === 403
            ? 'Only the family owner can manage billing.'
            : 'Billing recovery is temporarily unavailable.'}
        </p>
        <button onClick={() => owner.refetch()}>Retry</button>
        <button onClick={auth.logout}>Sign out</button>
      </main>
    );
  return (
    <Suspense fallback={<main role="status">Loading billing recovery…</main>}>
      <Billing />
    </Suspense>
  );
}
