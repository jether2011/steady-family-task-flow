import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
const state = vi.hoisted(() => ({ value: {} }));
vi.mock('@/lib/AuthContext', () => ({ useAuth: () => state.value }));
import ProtectedRoute from './ProtectedRoute';
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
function view() {
  render(
    <MemoryRouter>
      <Routes>
        <Route element={<ProtectedRoute />}>
          <Route path="/" element={<div>Management dashboard</div>} />
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
    view();
    expect(screen.getByText('Family access connected')).toBeInTheDocument();
    expect(screen.queryByText('Management dashboard')).not.toBeInTheDocument();
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
    expect(screen.getByText('Retry')).toBeInTheDocument();
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
