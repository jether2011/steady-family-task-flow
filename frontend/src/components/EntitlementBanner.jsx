import { Link } from 'react-router-dom';
import { useAuth } from '@/lib/AuthContext';
export default function EntitlementBanner() {
  const { access } = useAuth();
  const entitlement = access?.access;
  if (!entitlement) return null;
  const owner = access.membership?.role === 'OWNER';
  if (entitlement.state === 'READ_ONLY')
    return (
      <aside role="status" className="p-4 bg-accent border-b">
        Your family currently has view-only access.{' '}
        {owner ? (
          <Link className="underline" to="/billing">
            Manage subscription
          </Link>
        ) : (
          'Ask the family manager.'
        )}
      </aside>
    );
  if (
    owner &&
    ['GRACE', 'LEGACY', 'TRIAL'].includes(entitlement.state) &&
    entitlement.effectiveUntil
  )
    return (
      <aside role="status" className="p-4 bg-accent border-b">
        {entitlement.state === 'LEGACY'
          ? 'Legacy access'
          : entitlement.state === 'GRACE'
            ? 'Payment recovery access'
            : 'Trial access'}{' '}
        ends {new Date(entitlement.effectiveUntil).toLocaleString()}.{' '}
        <Link className="underline" to="/billing">
          Manage subscription
        </Link>
      </aside>
    );
  if (entitlement.reason === 'TEMPORARY')
    return (
      <aside role="status" className="p-4 bg-accent border-b">
        Family access is temporarily extended while verification recovers.{' '}
        {owner && <Link to="/billing">Review billing</Link>}
      </aside>
    );
  return null;
}
