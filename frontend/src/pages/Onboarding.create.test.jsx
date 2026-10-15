import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
const h = vi.hoisted(() => ({
  create: vi.fn(),
  load: vi.fn(),
  update: vi.fn(),
  navigate: vi.fn(),
  retry: vi.fn(),
  access: null,
}));
vi.mock('@/api/family.api', () => ({
  family: { create: h.create, onboarding: h.load, updateOnboarding: h.update },
}));
vi.mock('react-router-dom', async (orig) => ({
  ...(await orig()),
  useNavigate: () => h.navigate,
}));
vi.mock('@/lib/AuthContext', () => ({
  useAuth: () => ({
    isAuthenticated: true,
    authChecked: true,
    access: h.access,
    retryAccessResolution: h.retry,
  }),
  useOptionalAuth: () => ({ access: h.access, authChecked: true }),
}));
import Onboarding from './Onboarding';
const profile = {
  name: 'Existing Family',
  responsible_name: 'Owner',
  relationship: 'OTHER',
};
function show(creating = true) {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter>
        <Onboarding creating={creating} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  h.access = {
    state: 'NO_ACCESS',
    signupAvailable: true,
    user: { id: 'app', displayName: 'Tester' },
    family: null,
    membership: null,
  };
  h.retry.mockResolvedValue(undefined);
  h.create.mockResolvedValue({ nextAction: 'SUBSCRIBE' });
  h.load.mockResolvedValue({ family: profile, nextAction: 'COMPLETE_PROFILE' });
});
async function submit() {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('Family name'), 'New family');
  await user.click(screen.getByRole('button', { name: 'Create family' }));
}
describe('explicit tenant onboarding', () => {
  it('prefills editable identity text and redirects completed creation to subscription, never dashboard', async () => {
    show();
    expect(screen.getByLabelText('Your name')).toHaveValue('Tester');
    expect(
      screen.getByLabelText('Relationship to the family'),
    ).toBeInTheDocument();
    await submit();
    await waitFor(() =>
      expect(h.navigate).toHaveBeenCalledWith('/subscribe', { replace: true }),
    );
    expect(h.create).toHaveBeenCalledWith(
      {
        name: 'New family',
        responsible_name: 'Tester',
        relationship: 'FATHER',
      },
      expect.stringMatching(/^[a-f0-9-]{36}$/),
    );
    expect(h.retry).toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
  });
  it('keeps the same idempotency key across a lost response and retry', async () => {
    h.create.mockRejectedValueOnce(new Error('Connection lost'));
    show();
    await submit();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Connection lost',
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Create family' }),
    );
    await waitFor(() => expect(h.create).toHaveBeenCalledTimes(2));
    expect(h.create.mock.calls[0]).toEqual(h.create.mock.calls[1]);
  });
  it('resumes an existing legacy draft via onboarding PATCH and follows its server action', async () => {
    h.access = {
      ...h.access,
      state: 'ONBOARDING_REQUIRED',
      family: { id: 'family' },
      membership: { role: 'OWNER' },
    };
    h.update.mockResolvedValue({ nextAction: 'OPEN_DASHBOARD' });
    show(false);
    expect(await screen.findByLabelText('Family name')).toHaveValue(
      'Existing Family',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save profile' }));
    await waitFor(() =>
      expect(h.navigate).toHaveBeenCalledWith('/', { replace: true }),
    );
    expect(h.update).toHaveBeenCalledWith(profile);
    expect(h.create).not.toHaveBeenCalled();
  });
  it('does not present creation when the server disables signup', () => {
    h.access.signupAvailable = false;
    show();
    expect(
      screen.queryByRole('button', { name: 'Create family' }),
    ).not.toBeInTheDocument();
    expect(h.create).not.toHaveBeenCalled();
  });
  it('shows load failure and retry instead of submitting a new tenant', async () => {
    h.access = {
      ...h.access,
      state: 'ONBOARDING_REQUIRED',
      membership: { role: 'OWNER' },
      family: { id: 'family' },
    };
    h.load.mockRejectedValue(new Error('Unavailable'));
    show(false);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not load family profile',
    );
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(h.create).not.toHaveBeenCalled();
  });
});
