import React from 'react';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
const h = vi.hoisted(() => ({ access: null }));
vi.mock('@/lib/AuthContext', () => ({ useAuth: () => ({ access: h.access }) }));
import EntitlementBanner from './EntitlementBanner';
beforeEach(() => {
  h.access = {
    membership: { role: 'OWNER' },
    access: {
      state: 'READ_ONLY',
      reason: 'EXPIRED',
      effectiveUntil: null,
      version: 190,
    },
  };
});
const view = () =>
  render(
    <MemoryRouter>
      <EntitlementBanner />
    </MemoryRouter>,
  );
describe('role-safe access banners', () => {
  it('gives read-only owners a recovery link', () => {
    view();
    expect(screen.getByRole('status')).toHaveTextContent('view-only access');
    expect(
      screen.getByRole('link', { name: 'Manage subscription' }),
    ).toHaveAttribute('href', '/billing');
  });
  it.each(['MANAGER', 'MEMBER'])(
    'gives %s only the limited access notice',
    (role) => {
      h.access.membership.role = role;
      view();
      expect(screen.getByText(/Ask the family manager/)).toBeInTheDocument();
      expect(screen.queryByRole('link')).not.toBeInTheDocument();
      expect(
        screen.queryByText(/invoice|card|amount/i),
      ).not.toBeInTheDocument();
    },
  );
  it.each(['GRACE', 'LEGACY', 'TRIAL'])(
    'shows owner %s deadline without granting access on a countdown',
    (state) => {
      h.access.access = {
        ...h.access.access,
        state,
        effectiveUntil: '2030-01-01T00:00:00Z',
      };
      view();
      expect(screen.getByRole('status')).toHaveTextContent('ends');
      expect(screen.getByRole('link')).toHaveAttribute('href', '/billing');
    },
  );
});
