import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
const state = vi.hoisted(() => ({ value: {} }));
vi.mock('@/lib/AuthContext', () => ({ useAuth: () => state.value }));
import ProtectedRoute from './ProtectedRoute';
import AccessStatus from '@/pages/AccessStatus';
beforeEach(() => {
  state.value = {
    isAuthenticated: true,
    isLoadingAuth: false,
    authChecked: true,
    access: { state: 'READY', membership: { role: 'OWNER' } },
    logout: vi.fn(),
    retryAccessResolution: vi.fn(),
  };
});
function view(path = '/') {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        {['/no-access', '/access-revoked', '/access-error', '/subscribe'].map(
          (path) => (
            <Route key={path} path={path} element={<AccessStatus />} />
          ),
        )}
        <Route element={<ProtectedRoute />}>
          <Route path="/onboarding" element={<div>Owner profile form</div>} />
          <Route path="/" element={<div>Management dashboard</div>} />
          <Route path="/settings" element={<div>Settings</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}
describe('access boundary', () => {
  it.each(['OWNER', 'MANAGER'])('allows %s management access', (role) => {
    state.value.access.membership.role = role;
    view();
    expect(screen.getByText('Management dashboard')).toBeInTheDocument();
  });
  it('keeps member out of management dashboard', () => {
    state.value.access.membership.role = 'MEMBER';
    state.value.access.membership.memberId = 'self';
    view();
    expect(screen.getByText('Member views unavailable')).toBeInTheDocument();
    expect(screen.queryByText('Management dashboard')).not.toBeInTheDocument();
  });
  it('blocks management deep links before mounting their hooks', () => {
    state.value.access.membership = { role: 'MEMBER', memberId: 'self' };
    state.value.access.capabilities = ['member:views'];
    view('/settings');
    expect(
      screen.getByText('Page unavailable for your role'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Settings')).not.toBeInTheDocument();
  });
  it.each([
    ['NO_ACCESS', 'No family access'],
    ['REVOKED', 'Family access revoked'],
  ])('blocks %s', (status, label) => {
    state.value.access = { state: status };
    view();
    expect(screen.getByText(label)).toBeInTheDocument();
    expect(screen.queryByText('Management dashboard')).not.toBeInTheDocument();
  });
  it('clears content and exposes retry on resolution error', () => {
    state.value.authError = { message: 'Unavailable' };
    view();
    expect(screen.getByText('Retry access')).toBeInTheDocument();
    expect(screen.queryByText('Management dashboard')).not.toBeInTheDocument();
  });
  it('requires owner to complete onboarding', () => {
    state.value.access = {
      state: 'ONBOARDING_REQUIRED',
      membership: { role: 'MANAGER' },
    };
    view();
    expect(screen.getByText('Waiting for family setup')).toBeInTheDocument();
  });
});

describe('tenant lifecycle routing', () => {
  it('redirects an incomplete owner deep link before product content mounts', () => {
    state.value.access = {
      state: 'ONBOARDING_REQUIRED',
      membership: { role: 'OWNER' },
    };
    view('/settings');
    expect(screen.getByText('Owner profile form')).toBeInTheDocument();
    expect(screen.queryByText('Settings')).not.toBeInTheDocument();
  });
  it('shows a saved subscription placeholder without redirect loops for the unpaid owner', () => {
    state.value.access = {
      state: 'PAYMENT_REQUIRED',
      membership: { role: 'OWNER' },
    };
    view('/settings');
    expect(
      screen.getByText(/Subscriptions are not available yet/),
    ).toBeInTheDocument();
    expect(screen.queryByText('Settings')).not.toBeInTheDocument();
  });
  it('keeps billing recovery controls away from a non-owner', () => {
    state.value.access = {
      state: 'PAYMENT_REQUIRED',
      membership: { role: 'MEMBER' },
    };
    view();
    expect(
      screen.getByText('Ask the family owner to activate a subscription.'),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: 'Create a family' }),
    ).not.toBeInTheDocument();
  });
  it('shows creation only when the server reports eligibility', () => {
    state.value.access = { state: 'NO_ACCESS', signupAvailable: true };
    view();
    expect(
      screen.getByRole('link', { name: 'Create a family' }),
    ).toHaveAttribute('href', '/create-family');
  });
});
