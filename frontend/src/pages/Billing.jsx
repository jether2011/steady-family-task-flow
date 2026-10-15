import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { billing, hostedBillingUrl } from '@/api/billing.api';
import { useAuth } from '@/lib/AuthContext';
import { useScope } from '@/hooks/useScope';
import { Button } from '@/components/ui/button';
const statusLabels = {
  active: 'Active',
  canceled: 'Canceled',
  past_due: 'Payment overdue',
  unpaid: 'Payment required',
  incomplete: 'Payment pending',
  incomplete_expired: 'Checkout expired',
  trialing: 'Trial pending review',
  paused: 'Paused',
};
export default function Billing() {
  const auth = useAuth(),
    scope = useScope(),
    location = useLocation(),
    navigate = useNavigate();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [pollRound, setPollRound] = useState(0);
  const intent = useRef(crypto.randomUUID()),
    poll = useRef({ start: Date.now(), count: 0 });
  const scopeKey = JSON.stringify(scope.prefix);
  const currentScope = useRef(scopeKey),
    mounted = useRef(true);
  currentScope.current = scopeKey;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const isReturn = location.pathname === '/billing/return';
  const params = new URLSearchParams(location.search),
    returned = params.get('attempt');
  const plan = useQuery({
    queryKey: scope.key('billing-plan'),
    queryFn: ({ signal }) => billing.plan(signal),
    retry: false,
  });
  const subscription = useQuery({
    queryKey: scope.key('billing-subscription'),
    queryFn: ({ signal }) => billing.subscription(signal),
    retry: false,
    refetchOnWindowFocus: true,
  });
  const id = isReturn ? returned : subscription.data?.attemptId;
  const validId =
    typeof id === 'string' &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id);
  const attempt = useQuery({
    queryKey: scope.key('billing-attempt', id, pollRound),
    queryFn: ({ signal }) => billing.attempt(id, signal),
    enabled: validId,
    retry: false,
    refetchOnWindowFocus: true,
    refetchInterval: (query) => {
      if (
        !isReturn ||
        Date.now() - poll.current.start >= 120000 ||
        query.state.error ||
        ['CONFIRMED', 'FAILED'].includes(query.state.data?.activation)
      )
        return false;
      const delay = [2000, 4000, 8000, 10000][
        Math.min(Math.max(0, query.state.dataUpdateCount - 1), 3)
      ];
      return Math.min(delay, 120000 - (Date.now() - poll.current.start));
    },
  });
  useEffect(() => {
    if (isReturn && attempt.data?.activation === 'CONFIRMED') {
      auth.retryAccessResolution().then(() => {
        if (mounted.current && currentScope.current === scopeKey)
          navigate('/', { replace: true });
      });
    }
  }, [
    isReturn,
    attempt.data?.activation,
    auth.retryAccessResolution,
    navigate,
    scopeKey,
  ]);
  const leave = (url, kind) =>
    window.location.assign(hostedBillingUrl(url, kind));
  async function purchase() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      if (attempt.data?.activation === 'FAILED')
        intent.current = crypto.randomUUID();
      const result = await billing.checkout(intent.current);
      if (!mounted.current || currentScope.current !== scopeKey) return;
      if (result.url) leave(result.url, 'checkout');
      else if (result.attemptId)
        navigate('/billing/return?attempt=' + result.attemptId);
      else {
        await subscription.refetch();
        setError(
          'Billing is being reconciled. Recheck shortly before starting checkout.',
        );
      }
    } catch (err) {
      if (!mounted.current || currentScope.current !== scopeKey) return;
      setError(err.message || 'Could not start checkout. Retry safely.');
      await subscription.refetch();
    } finally {
      if (mounted.current && currentScope.current === scopeKey) setBusy(false);
    }
  }
  async function openPortal() {
    setBusy(true);
    setError('');
    try {
      const result = await billing.portal();
      if (!mounted.current || currentScope.current !== scopeKey) return;
      leave(result.url, 'portal');
    } catch (err) {
      if (!mounted.current || currentScope.current !== scopeKey) return;
      setError(err.message || 'Could not open billing portal.');
    } finally {
      if (mounted.current && currentScope.current === scopeKey) setBusy(false);
    }
  }
  function recheck() {
    poll.current = { start: Date.now(), count: 0 };
    setPollRound((v) => v + 1);
    plan.refetch();
    subscription.refetch();
  }
  const p = plan.data ?? subscription.data?.plan,
    s = subscription.data,
    t = attempt.data;
  return (
    <main className="max-w-xl mx-auto p-6 space-y-5">
      <h1 className="text-2xl font-bold">
        {isReturn ? 'Confirming your subscription' : 'Family subscription'}
      </h1>
      {location.search.includes('checkout=canceled') && (
        <p role="status">Checkout canceled. Your family draft is saved.</p>
      )}
      {error && <p role="alert">{error}</p>}
      {(plan.error || subscription.error || attempt.error) && (
        <p role="alert">
          Could not refresh billing. Your family and payment history are
          preserved. Recheck before making another purchase.
        </p>
      )}
      {(plan.isPending || subscription.isPending) && (
        <p role="status">Loading billing…</p>
      )}
      {isReturn && !validId && (
        <p role="alert">
          A valid checkout attempt is required. Open subscription settings to
          recover your checkout.
        </p>
      )}
      {isReturn && validId && t?.activation !== 'CONFIRMED' && (
        <p role="status">
          {t?.activation === 'FAILED'
            ? 'Checkout ended without activation. Return to subscription settings to try again.'
            : t?.nextAction === 'CONTACT_SUPPORT'
              ? 'Billing needs support review. Please contact support.'
              : 'Payment confirmation is pending. Access opens only after the server confirms activation. You can close this page and return later, or recheck.'}
        </p>
      )}
      {p?.title && (
        <section className="rounded-xl border p-5 space-y-3">
          <h2 className="font-semibold">{p.title}</h2>
          {p.currency && p.unitAmount !== null && (
            <p>
              {new Intl.NumberFormat(undefined, {
                style: 'currency',
                currency: p.currency,
              }).format(
                p.unitAmount /
                  10 **
                    (['isk', 'ugx'].includes(p.currency.toLowerCase())
                      ? 2
                      : new Intl.NumberFormat('en', {
                          style: 'currency',
                          currency: p.currency,
                        }).resolvedOptions().maximumFractionDigits),
              )}{' '}
              per month
            </p>
          )}
          <p>{p.taxDisclosure}</p>
          <ul className="list-disc pl-5">
            {p.features.map((feature) => (
              <li key={feature}>{feature}</li>
            ))}
          </ul>
          <p>
            {p.memberLimit === null
              ? 'Unlimited members'
              : `Up to ${p.memberLimit} members`}
          </p>
          <p className="flex flex-wrap gap-4">
            {[
              [p.termsUrl, 'Terms'],
              [p.privacyUrl, 'Privacy'],
              [p.policyUrl, 'Cancellation and refund policy'],
            ].map(
              ([url, label]) =>
                url && (
                  <a
                    key={label}
                    href={url}
                    target="_blank"
                    rel="noreferrer"
                    className="underline"
                  >
                    {label}
                  </a>
                ),
            )}
          </p>
        </section>
      )}
      {s?.status && (
        <section aria-label="Subscription status" className="space-y-2">
          <p>Status: {statusLabels[s.status] ?? 'Updating'}</p>
          {s.cancelAtPeriodEnd && (
            <p>Cancellation is scheduled at the end of the paid period.</p>
          )}
          {s.paidThrough && (
            <p>Paid through: {new Date(s.paidThrough).toLocaleString()}</p>
          )}
          {s.nextBillingAt && (
            <p>
              Next billing period: {new Date(s.nextBillingAt).toLocaleString()}
            </p>
          )}
        </section>
      )}
      {!plan.isPending && !p?.available && !isReturn && (
        <p>
          {auth.access?.state === 'PAYMENT_REQUIRED'
            ? 'Subscriptions are not available yet. Your family draft is saved.'
            : 'New subscriptions are unavailable. Existing billing recovery remains available.'}
        </p>
      )}
      {s?.recoveryAction === 'CONTACT_SUPPORT' && (
        <p role="status">
          Billing needs support review before another checkout can start.
        </p>
      )}
      <div className="flex flex-wrap gap-3">
        {!isReturn && p?.available && s?.recoveryAction === 'SUBSCRIBE' && (
          <Button disabled={busy || subscription.isPending} onClick={purchase}>
            Subscribe monthly
          </Button>
        )}
        {!isReturn && s?.recoveryAction === 'RESUME_CHECKOUT' && t?.url && (
          <Button disabled={busy} onClick={() => leave(t.url, 'checkout')}>
            Resume checkout
          </Button>
        )}
        {!isReturn &&
          s?.recoveryAction === 'RESUME_CHECKOUT' &&
          id &&
          !t?.url && (
            <Link to={'/billing/return?attempt=' + id}>
              View payment confirmation
            </Link>
          )}
        {s?.recoveryAction === 'OPEN_PORTAL' && (
          <Button disabled={busy} onClick={openPortal}>
            Manage billing and invoices
          </Button>
        )}
        <Button variant="outline" disabled={busy} onClick={recheck}>
          Recheck billing
        </Button>
      </div>
      <nav className="flex gap-4">
        <Link to="/subscribe">Subscription settings</Link>
        {auth.access?.state === 'READY' && <Link to="/">Dashboard</Link>}
        <button onClick={auth.logout}>Sign out</button>
      </nav>
    </main>
  );
}
