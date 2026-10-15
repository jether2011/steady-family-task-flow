import React from 'react';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
const h = vi.hoisted(() => ({ auth: null, mount: vi.fn() }));
vi.mock('@/lib/AuthContext', () => ({ useAuth: () => h.auth }));
vi.mock('@/pages/Billing', () => ({
  default: () => {
    h.mount();
    return <div>Private owner invoices</div>;
  },
}));
import BillingRoute from './BillingRoute';
beforeEach(() => {
  vi.clearAllMocks();
  h.auth = {
    isAuthenticated: true,
    authChecked: true,
    isLoadingAuth: false,
    access: { state: 'PAYMENT_REQUIRED', membership: { role: 'OWNER' } },
    retryAccessResolution: vi.fn(),
    logout: vi.fn(),
  };
});
function view() {
  render(
    <MemoryRouter initialEntries={['/subscribe']}>
      <Routes>
        <Route path="/subscribe" element={<BillingRoute />} />
        <Route path="/no-access" element={<div>No family</div>} />
      </Routes>
    </MemoryRouter>,
  );
}
describe('lazy owner billing gate', () => {
  it('loads owner invoices only after role resolution', async () => {
    view();
    expect(
      await screen.findByText('Private owner invoices'),
    ).toBeInTheDocument();
  });
  it.each(['MANAGER', 'MEMBER'])(
    'does not mount billing APIs for %s',
    (role) => {
      h.auth.access.membership.role = role;
      view();
      expect(
        screen.getByText('Ask the family owner to activate a subscription.'),
      ).toBeInTheDocument();
      expect(h.mount).not.toHaveBeenCalled();
    },
  );
  it('does not start owner APIs while identity is unresolved', () => {
    h.auth.isLoadingAuth = true;
    view();
    expect(screen.getByRole('status')).toHaveTextContent(
      'Resolving billing access',
    );
    expect(h.mount).not.toHaveBeenCalled();
  });
});
