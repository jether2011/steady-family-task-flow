import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
const h = vi.hoisted(() => ({ subscription: vi.fn(), mount: vi.fn() }));
vi.mock('@/lib/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'subject' }, logout: vi.fn() }),
}));
vi.mock('@/api/billing.api', () => ({
  billing: { subscription: h.subscription },
}));
vi.mock('@/pages/Billing', () => ({
  default: () => {
    h.mount();
    return <div>Authorized owner recovery</div>;
  },
}));
import BillingRecovery from './BillingRecovery';
beforeEach(() => {
  vi.clearAllMocks();
});
function show() {
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <BillingRecovery />
    </QueryClientProvider>,
  );
}
describe('projection outage recovery', () => {
  it('requires server-confirmed ownership before displaying billing recovery', async () => {
    h.subscription.mockResolvedValue({ status: 'past_due' });
    show();
    expect(
      await screen.findByText('Authorized owner recovery'),
    ).toBeInTheDocument();
  });
  it('does not mount invoice controls for a manager/member when /me is unavailable', async () => {
    h.subscription.mockRejectedValue({ status: 403 });
    show();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Only the family owner',
    );
    expect(h.mount).not.toHaveBeenCalled();
  });
});
