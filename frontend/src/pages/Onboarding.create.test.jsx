vi.mock('@/hooks/useScope', () => ({
  useScope: () => ({
    prefix: ['scope', 'test-user', 'test-family', 'OWNER', 1],
    key: (...parts) => [
      'scope',
      'test-user',
      'test-family',
      'OWNER',
      1,
      ...parts,
    ],
    enabled: true,
    role: 'OWNER',
    canManage: true,
    memberId: null,
  }),
}));
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

// Onboarding behavior after the flow rework:
//  - Google OAuth lands here; the family row already exists (auto-created by
//    /me) but is UNCONFIGURED (relationship/responsible_name null).
//  - "Create family" (PATCH /family via useCreateFamily) fills the profile and
//    navigates to "/".
//  - A failure shows a meaningful toast.
//  - The "Load sample family" option was removed.
//  - If the family is ALREADY configured, onboarding redirects to "/".

const h = vi.hoisted(() => ({
  navigate: vi.fn(),
  createFamilyMutateAsync: vi.fn(),
  createFamilyPending: false,
  family: {
    id: 'fam-1',
    name: 'My Family',
    relationship: null,
    responsible_name: null,
  },
  familyLoading: false,
  user: { full_name: 'Jether', email: 'jether@example.com' },
  toast: vi.fn(),
}));

vi.mock('react-router-dom', async (orig) => {
  const actual = await orig();
  return { ...actual, useNavigate: () => h.navigate };
});

vi.mock('@/hooks/useFamily', () => ({
  useFamily: () => ({ data: h.family, isLoading: h.familyLoading }),
  useCreateFamily: () => ({
    mutateAsync: h.createFamilyMutateAsync,
    isPending: h.createFamilyPending,
  }),
}));

vi.mock('@/lib/AuthContext', () => ({
  useAuth: () => ({ user: h.user }),
}));

vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: h.toast }),
  toast: h.toast,
}));

import Onboarding from '@/pages/Onboarding';

function renderOnboarding() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.refetchQueries = vi.fn().mockResolvedValue(undefined);
  qc.invalidateQueries = vi.fn().mockResolvedValue(undefined);
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <Onboarding />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  h.family = {
    id: 'fam-1',
    name: 'My Family',
    relationship: null,
    responsible_name: null,
  };
  h.familyLoading = false;
  h.createFamilyPending = false;
  h.user = { full_name: 'Jether', email: 'jether@example.com' };
});

describe('Onboarding — Create family', () => {
  it('prefills "Your name" from the Google profile', async () => {
    renderOnboarding();
    await waitFor(() =>
      expect(screen.getByLabelText(/your name/i)).toHaveValue('Jether'),
    );
  });

  it('submits the flat body and navigates to "/" on success', async () => {
    h.createFamilyMutateAsync.mockResolvedValue({ id: 'fam-1' });
    const user = userEvent.setup();
    renderOnboarding();

    const famInput = screen.getByLabelText(/family name/i);
    await user.clear(famInput);
    await user.type(famInput, 'Rodrigues Family');
    await user.click(screen.getByRole('button', { name: /create family/i }));

    await waitFor(() =>
      expect(h.createFamilyMutateAsync).toHaveBeenCalledTimes(1),
    );
    expect(h.createFamilyMutateAsync).toHaveBeenCalledWith({
      name: 'Rodrigues Family',
      responsible_name: 'Jether',
      relationship: 'FATHER',
    });
    await waitFor(() =>
      expect(h.navigate).toHaveBeenCalledWith('/', { replace: true }),
    );
  });

  it('surfaces the API error message in a toast on failure (meaningful, not blank)', async () => {
    h.createFamilyMutateAsync.mockRejectedValue(
      new Error(
        'Cannot reach the server at http://localhost:8080/api/v1. Is the backend running and is VITE_API_URL correct?',
      ),
    );
    const user = userEvent.setup();
    renderOnboarding();

    const famInput = screen.getByLabelText(/family name/i);
    await user.clear(famInput);
    await user.type(famInput, 'Rodrigues Family');
    await user.click(screen.getByRole('button', { name: /create family/i }));

    await waitFor(() => expect(h.toast).toHaveBeenCalled());
    const arg = h.toast.mock.calls.at(-1)[0];
    expect(arg.variant).toBe('destructive');
    expect(arg.description).toContain('Cannot reach the server');
    expect(h.navigate).not.toHaveBeenCalled();
  });

  it('does NOT offer a "Load sample family" option', () => {
    renderOnboarding();
    expect(
      screen.queryByRole('button', { name: /sample/i }),
    ).not.toBeInTheDocument();
  });

  it('redirects to "/" when the family is already configured', () => {
    h.family = {
      id: 'fam-1',
      name: 'Rodrigues Family',
      relationship: 'FATHER',
      responsible_name: 'Jether',
    };
    renderOnboarding();
    // Navigate (react-router) renders nothing visible; assert the setup form is
    // not shown (the configured-family short-circuit returned <Navigate/>).
    expect(
      screen.queryByRole('button', { name: /create family/i }),
    ).not.toBeInTheDocument();
  });
});
