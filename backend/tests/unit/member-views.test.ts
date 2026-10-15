import { beforeEach, describe, it, expect, vi } from 'vitest';
vi.hoisted(() =>
  Object.assign(process.env, {
    SUPABASE_URL: 'https://project.supabase.co',
    SUPABASE_PUBLISHABLE_KEY: 'test',
    SUPABASE_SECRET_KEY: 'test-cursor-secret',
    CORS_ORIGIN: 'http://localhost',
  }),
);
const mock = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../../src/config/supabase.js', () => ({
  getServiceRoleClient: () => ({ rpc: mock.rpc }),
}));
import {
  historyScope,
  encodeCursor,
  decodeCursor,
  historyPage,
} from '../../src/modules/member-views/views.service.js';
import { rankEntries } from '../../src/modules/gamification/leaderboard.service.js';
import { periodStart } from '../../src/shared/utils/dates.js';
const ctx = {
  authUserId: 'auth',
  appUserId: 'app',
  familyId: 'family',
  memberId: 'self',
  role: 'MEMBER' as const,
  accessVersion: 2,
};
const id = '00000000-0000-4000-8000-000000000001',
  stamp = '2026-10-15T12:00:00.123456+00:00';
beforeEach(() => mock.rpc.mockReset());
describe('history cursor isolation', () => {
  it('preserves submillisecond precision and validates its signature', () => {
    const scope = historyScope(ctx, 'points', {
        memberId: 'self',
        from: '2026-01-01',
      }),
      cursor = encodeCursor(stamp, id, scope);
    expect(decodeCursor(cursor, scope)).toEqual({
      pageTime: stamp,
      pageId: id,
    });
    expect(() => decodeCursor(cursor + 'tampered', scope)).toThrow(
      'Invalid history cursor',
    );
  });
  it.each([
    { familyId: 'other' },
    { appUserId: 'other' },
    { accessVersion: 3 },
    { role: 'MANAGER' as const },
  ])('rejects a changed scope %o', (change) => {
    const cursor = encodeCursor(stamp, id, historyScope(ctx, 'points', {}));
    expect(() =>
      decodeCursor(cursor, historyScope({ ...ctx, ...change }, 'points', {})),
    ).toThrow();
  });
  it('binds cursors to filters and resource type rather than page size', () => {
    const scope = historyScope(ctx, 'points', { from: '2026-01-01', limit: 5 });
    expect(
      historyScope(ctx, 'points', { limit: 100, from: '2026-01-01' }),
    ).toBe(scope);
    const cursor = encodeCursor(stamp, id, scope);
    expect(() =>
      decodeCursor(cursor, historyScope(ctx, 'points', { from: '2026-01-02' })),
    ).toThrow();
    expect(() =>
      decodeCursor(
        cursor,
        historyScope(ctx, 'completions', { from: '2026-01-01' }),
      ),
    ).toThrow();
  });
  it('returns only the requested page and a signed continuation', async () => {
    mock.rpc.mockResolvedValue({
      data: {
        transactions: [
          { id, created_at: stamp },
          { id: '00000000-0000-4000-8000-000000000002', created_at: stamp },
        ],
      },
      error: null,
    });
    const result = await historyPage(ctx, 'points', { limit: 1 });
    expect(result.transactions).toHaveLength(1);
    expect(result.nextCursor).not.toBeNull();
    expect(
      decodeCursor(result.nextCursor!, historyScope(ctx, 'points', {})),
    ).toEqual({ pageTime: stamp, pageId: id });
  });
});
describe('shared leaderboard view policy', () => {
  it('gives competition ranks and stabilizes identical scores by ID', () => {
    const entry = {
      name: 'Person',
      avatarUrl: null,
      color: null,
      points: 5,
      completedTasks: 1,
    };
    expect(
      rankEntries([
        { ...entry, memberId: 'b' },
        { ...entry, memberId: 'a' },
        { ...entry, memberId: 'c', points: -1 },
      ]).map((r) => [r.memberId, r.rank]),
    ).toEqual([
      ['a', 1],
      ['b', 1],
      ['c', 3],
    ]);
  });
  it('preserves rolling UTC week and month-end rollover boundaries without a fake all-time cutoff', () => {
    const now = new Date('2024-03-31T23:59:00Z');
    expect(periodStart('week', now)).toBe('2024-03-25T00:00:00.000Z');
    expect(periodStart('month', now)).toBe('2024-03-02T00:00:00.000Z');
    expect(periodStart('all', now)).toBeNull();
  });
});
