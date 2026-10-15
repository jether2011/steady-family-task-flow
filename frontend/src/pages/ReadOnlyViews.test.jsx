import React from 'react';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
const h = vi.hoisted(() => ({ canManage: false }));
vi.mock('@/hooks/useScope', () => ({
  useScope: () => ({
    canManage: h.canManage,
    canRevoke: false,
    canReadManagement: true,
    role: 'MANAGER',
    prefix: ['test'],
    key: (...p) => ['test', ...p],
  }),
}));
vi.mock('@/hooks/useFamily', () => ({
  useFamily: () => ({
    data: { name: 'Saved family', responsible_name: 'Owner' },
  }),
  useTemplates: () => ({
    data: [{ id: 'template', title: 'Recurring chore', points: 10 }],
  }),
  useMembers: () => ({
    data: [
      { id: 'member', name: 'Person', member_type: 'CHILD', active: true },
    ],
  }),
  usePoints: () => ({ data: [] }),
  useDeleteMember: () => ({ mutateAsync: vi.fn() }),
  useSaveMember: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock('@/components/members/MemberModal', () => ({ default: () => null }));
vi.mock('@/components/members/SecurityRevokeButton', () => ({
  default: () => null,
}));
vi.mock('@/pages/MemberBoard', () => ({
  default: () => <div>Shared board without drag or edit</div>,
}));
import Settings from './Settings';
import TaskTemplates from './TaskTemplates';
import Members from './Members';
import Board from './Board';
function show(component) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>{component}</MemoryRouter>
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  h.canManage = false;
});
describe('read-only management views', () => {
  it('shows settings without a writable form', () => {
    show(<Settings />);
    expect(screen.getByText('Saved family')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /save/i }),
    ).not.toBeInTheDocument();
  });
  it('shows templates without generation, create or edit controls', () => {
    show(<TaskTemplates />);
    expect(screen.getByText(/Recurring chore/)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
  it('retains roster/profile viewing without editing or deactivation', () => {
    show(<Members />);
    expect(screen.getByText('Person')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View profile' })).toHaveAttribute(
      'href',
      '/member-profile?member=member',
    );
    expect(
      screen.queryByRole('button', { name: /add|edit|deactivate/i }),
    ).not.toBeInTheDocument();
  });
  it('mounts the shared board before any writable drag hooks for a restricted manager', () => {
    show(<Board />);
    expect(
      screen.getByText('Shared board without drag or edit'),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /new task|generate/i }),
    ).not.toBeInTheDocument();
  });
});
