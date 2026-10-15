import React from 'react';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
const h = vi.hoisted(() => ({
  plan: vi.fn(),
  subscription: vi.fn(),
  attempt: vi.fn(),
  checkout: vi.fn(),
  portal: vi.fn(),
  navigate: vi.fn(),
  retry: vi.fn(),
}));
vi.mock('@/api/billing.api', () => ({
  billing: {
    plan: h.plan,
    subscription: h.subscription,
    attempt: h.attempt,
    checkout: h.checkout,
    portal: h.portal,
  },
  hostedBillingUrl: vi.fn((url) => url),
}));
vi.mock('react-router-dom', async (orig) => ({
  ...(await orig()),
  useNavigate: () => h.navigate,
}));
vi.mock('@/lib/AuthContext', () => ({
  useAuth: () => ({
    access: { state: 'PAYMENT_REQUIRED' },
    retryAccessResolution: h.retry,
    logout: vi.fn(),
  }),
}));
vi.mock('@/hooks/useScope', () => ({
  useScope: () => ({ key: (...parts) => ['owner', 'family', ...parts] }),
}));
import Billing from './Billing';
import { hostedBillingUrl } from '@/api/billing.api';
const id = '00000000-0000-4000-8000-000000000001';
const plan = {
  title: 'Approved fixture plan',
  currency: 'usd',
  unitAmount: 1234,
  interval: 'month',
  features: ['Shared family board'],
  memberLimit: 5,
  taxDisclosure: 'Tax fixture disclosure',
  termsUrl: 'https://app.example.test/terms',
  privacyUrl: 'https://app.example.test/privacy',
  policyUrl: 'https://app.example.test/policy',
  available: true,
};
function view(path = '/subscribe') {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter initialEntries={[path]}>
        <Billing />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  h.plan.mockResolvedValue(plan);
  h.subscription.mockResolvedValue({
    status: null,
    attemptId: null,
    recoveryAction: 'SUBSCRIBE',
  });
  h.retry.mockResolvedValue(undefined);
  h.attempt.mockResolvedValue({
    attemptId: id,
    state: 'COMPLETED',
    activation: 'PENDING',
    nextAction: 'WAIT',
  });
});
describe('hosted owner billing', () => {
  it('shows the approved price, taxes and policies before purchase', async () => {
    view();
    expect(
      await screen.findByText('Approved fixture plan'),
    ).toBeInTheDocument();
    expect(screen.getByText(/12.34 per month/)).toBeInTheDocument();
    expect(screen.getByText('Tax fixture disclosure')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Terms' })).toHaveAttribute(
      'href',
      plan.termsUrl,
    );
    expect(
      screen.getByRole('button', { name: 'Subscribe monthly' }),
    ).toBeInTheDocument();
  });
  it('keeps a stable request key on transport retry and recovers a durable pending attempt', async () => {
    h.checkout
      .mockRejectedValueOnce(new Error('Connection lost'))
      .mockResolvedValue({ attemptId: id, state: 'PROCESSING' });
    view();
    await userEvent.click(
      await screen.findByRole('button', { name: 'Subscribe monthly' }),
    );
    expect(await screen.findByText('Connection lost')).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole('button', { name: 'Subscribe monthly' }),
    );
    await waitFor(() =>
      expect(h.navigate).toHaveBeenCalledWith('/billing/return?attempt=' + id),
    );
    expect(h.checkout.mock.calls[0][0]).toBe(h.checkout.mock.calls[1][0]);
  });
  it('does not navigate from a successful return URL before server activation', async () => {
    view('/billing/return?attempt=' + id + '&paid=true');
    expect(
      await screen.findByText(/Payment confirmation is pending/),
    ).toBeInTheDocument();
    expect(h.attempt).toHaveBeenCalledWith(id, expect.anything());
    expect(h.navigate).not.toHaveBeenCalled();
    expect(h.retry).not.toHaveBeenCalled();
  });
  it('refreshes identity and navigates only on server-confirmed activation', async () => {
    h.attempt.mockResolvedValue({
      attemptId: id,
      state: 'COMPLETED',
      activation: 'CONFIRMED',
      nextAction: 'OPEN_DASHBOARD',
    });
    view('/billing/return?attempt=' + id);
    await waitFor(() =>
      expect(h.navigate).toHaveBeenCalledWith('/', { replace: true }),
    );
    expect(h.retry).toHaveBeenCalled();
  });
  it('keeps an unavailable plan and canceled checkout recoverable without buying again', async () => {
    h.plan.mockResolvedValue({ ...plan, available: false });
    view('/subscribe?checkout=canceled');
    expect(
      await screen.findByText(/Subscriptions are not available yet/),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Checkout canceled. Your family draft is saved.'),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Subscribe monthly' }),
    ).not.toBeInTheDocument();
  });
  it('offers billing recovery for a failed renewal even when new checkout is disabled', async () => {
    h.plan.mockResolvedValue({ ...plan, available: false });
    h.subscription.mockResolvedValue({
      status: 'past_due',
      recoveryAction: 'OPEN_PORTAL',
      cancelAtPeriodEnd: true,
      paidThrough: '2026-11-01T00:00:00Z',
    });
    view('/billing');
    expect(
      await screen.findByRole('button', {
        name: 'Manage billing and invoices',
      }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Cancellation is scheduled/)).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Subscribe monthly' }),
    ).not.toBeInTheDocument();
  });
  it('allows explicit recheck after an outage without inferring payment', async () => {
    h.attempt.mockRejectedValue(new Error('Unavailable'));
    view('/billing/return?attempt=' + id);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not refresh billing',
    );
    h.attempt.mockResolvedValue({ activation: 'PENDING', nextAction: 'WAIT' });
    await userEvent.click(
      screen.getByRole('button', { name: 'Recheck billing' }),
    );
    await waitFor(() => expect(h.attempt).toHaveBeenCalledTimes(2));
    expect(h.navigate).not.toHaveBeenCalled();
  });
  it('ignores a late hosted checkout response after leaving the owner context', async () => {
    let resolve;
    h.checkout.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const mounted = view();
    await userEvent.click(
      await screen.findByRole('button', { name: 'Subscribe monthly' }),
    );
    mounted.unmount();
    await act(async () => {
      resolve({
        url: 'https://checkout.stripe.com/c/pay/fixture',
        attemptId: id,
      });
    });
    expect(hostedBillingUrl).not.toHaveBeenCalled();
    expect(h.navigate).not.toHaveBeenCalled();
  });
});
