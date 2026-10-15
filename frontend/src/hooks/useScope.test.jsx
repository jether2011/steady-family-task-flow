import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
const state = vi.hoisted(() => ({
  auth: null,
  tasks: vi.fn(),
  members: vi.fn(),
  points: vi.fn(),
}));
vi.mock('@/lib/AuthContext', () => ({ useOptionalAuth: () => state.auth }));
vi.mock('@/api/tasks.api', () => ({ tasks: { list: state.tasks } }));
vi.mock('@/api/members.api', () => ({ members: { list: state.members } }));
vi.mock('@/api/points.api', () => ({ points: { list: state.points } }));
import { useScope } from './useScope';
import { useTasks, useMembers, usePoints } from './useFamily';
function auth(role = 'OWNER', version = 1) {
  return {
    authChecked: true,
    access: {
      state: 'READY',
      user: { id: 'app' },
      family: { id: 'family' },
      membership: { role, memberId: 'self', accessVersion: version },
      capabilities: role === 'MEMBER' ? ['member:views'] : ['family:manage'],
    },
  };
}
beforeEach(() => {
  state.auth = auth();
  state.tasks.mockReset().mockResolvedValue([{ id: 'task', title: 'Shared' }]);
  state.members
    .mockReset()
    .mockResolvedValue([{ id: 'person', birth_year: 2010 }]);
  state.points
    .mockReset()
    .mockResolvedValue([{ member_id: 'other', points: 42 }]);
});
function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return {
    ...renderHook(
      () => ({
        scope: useScope(),
        tasks: useTasks(),
        members: useMembers(),
        points: usePoints(),
      }),
      {
        wrapper: ({ children }) => (
          <QueryClientProvider client={client}>{children}</QueryClientProvider>
        ),
      },
    ),
    client,
  };
}
describe('query scope follows trusted access state', () => {
  it('isolates demoted member queries from prior manager private results', async () => {
    const view = setup();
    await waitFor(() =>
      expect(view.result.current.points.data).toHaveLength(1),
    );
    expect(view.result.current.scope.key('points')).toEqual([
      'scope',
      'app',
      'family',
      'OWNER',
      1,
      null,
      'points',
    ]);
    state.auth = auth('MEMBER', 2);
    view.rerender();
    await waitFor(() => expect(view.result.current.tasks.data).toHaveLength(1));
    expect(view.result.current.points.data).toBeUndefined();
    expect(view.result.current.members.data).toBeUndefined();
    expect(state.points).toHaveBeenCalledTimes(1);
    expect(state.members).toHaveBeenCalledTimes(1);
    expect(view.result.current.scope.key('points')).toEqual([
      'scope',
      'app',
      'family',
      'MEMBER',
      2,
      null,
      'points',
    ]);
  });
  it('does not fetch any protected query when access resolution is missing', () => {
    state.auth = null;
    const view = setup();
    expect(view.result.current.scope.enabled).toBe(false);
    expect(state.tasks).not.toHaveBeenCalled();
    expect(state.points).not.toHaveBeenCalled();
    expect(state.members).not.toHaveBeenCalled();
  });
 it('changes cache scope at an entitlement boundary while retaining manager read privacy',async()=>{
  state.auth.access.access={state:'ACTIVE',version:210};const view=setup();await waitFor(()=>expect(view.result.current.members.data).toHaveLength(1));const oldKey=view.result.current.scope.key('tasks');
  state.auth={...state.auth,access:{...state.auth.access,capabilities:['members:read','members:security-revoke','points:all'],access:{state:'READ_ONLY',version:290}}};view.rerender();
  expect(view.result.current.scope.key('tasks')).not.toEqual(oldKey);expect(view.result.current.scope.canManage).toBe(false);expect(view.result.current.scope.canReadManagement).toBe(true);expect(view.result.current.scope.canRevoke).toBe(true);
  await waitFor(()=>expect(view.result.current.members.data).toHaveLength(1));
 });

});
