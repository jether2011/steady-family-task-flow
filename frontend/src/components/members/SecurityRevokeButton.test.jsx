import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
const h = vi.hoisted(() => ({
  get: vi.fn(),
  revoke: vi.fn(),
  canRevoke: true,
}));
vi.mock('@/hooks/useScope', () => ({
  useScope: () => ({
    canRevoke: h.canRevoke,
    prefix: ['readonly-manager'],
    key: (...p) => ['readonly-manager', ...p],
  }),
}));
vi.mock('@/api/members.api', () => ({
  members: { getAccess: h.get, revokeAccess: h.revoke },
}));
import SecurityRevokeButton from './SecurityRevokeButton';
beforeEach(() => {
  vi.clearAllMocks();
  h.canRevoke = true;
  h.get.mockResolvedValue({
    status: 'ACTIVE',
    role: 'MEMBER',
    accessVersion: 8,
  });
  h.revoke.mockResolvedValue({ access: { status: 'REVOKED' } });
});
const show = () =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <SecurityRevokeButton memberId="participant" />
    </QueryClientProvider>,
  );
describe('read-only security exception', () => {
  it('sends only the member ID and current expected version for revocation', async () => {
    show();
    await userEvent.click(
      await screen.findByRole('button', { name: 'Revoke login' }),
    );
    await waitFor(() =>
      expect(h.revoke).toHaveBeenCalledWith('participant', 8),
    );
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });
  it('does not fetch or offer the exception without the role capability', () => {
    h.canRevoke = false;
    show();
    expect(h.get).not.toHaveBeenCalled();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
