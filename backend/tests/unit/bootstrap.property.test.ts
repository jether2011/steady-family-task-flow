/**
 * Property-based test for the `/me` bootstrap service (task 4.4).
 *
 * **Property 1: Family bootstrap is idempotent** — for any authenticated
 * responsible user (verified `auth_user_id`) and any identity claims, calling
 * `bootstrapMe` any number of consecutive times (N ≥ 1) results in EXACTLY ONE
 * `responsible_users` row and EXACTLY ONE `families` row for that user, and
 * every call returns the SAME composed family (same `id` and DTO) — the first
 * call creates (R1.4), every later call returns the existing one (R1.5), and
 * `UNIQUE(auth_user_id)` / `UNIQUE(responsible_user_id)` guarantee at most one
 * of each (R1.6).
 *
 * **Validates: Requirements 1.4, 1.5, 1.6**
 *
 * `bootstrapMe` drives the Supabase service-role client directly (it does not
 * go through a repository layer), using exactly this query-builder surface:
 *   - `from('responsible_users').select(cols).eq('auth_user_id', id).maybeSingle()`
 *   - `from('responsible_users').insert({...}).select(cols).single()`
 *   - `from('families').select(cols).eq('responsible_user_id', id).maybeSingle()`
 *   - `from('families').insert({...}).select(cols).single()`
 * and reads `error.code === '23505'` (unique_violation) to take the re-select
 * race path. So the faithful fake here is the Supabase client itself: we mock
 * `src/config/supabase.js` so `getServiceRoleClient()` returns an in-memory
 * client backed by two Maps that enforce the two UNIQUE constraints — a second
 * insert for the same key returns `{ data: null, error: { code: '23505' } }`,
 * exercising the service's re-select fallback. No database or env is involved.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';

import type {
  FamilyRow,
  ResponsibleUserRow,
} from '../../src/shared/types/index.js';
import type { AuthClaims } from '../../src/middleware/types.js';

const UNIQUE_VIOLATION = '23505';

/**
 * In-memory store standing in for the two tables bootstrap touches. Enforces
 * `UNIQUE(auth_user_id)` on `responsible_users` and
 * `UNIQUE(responsible_user_id)` on `families` (R1.6) via the Maps' keys.
 */
class FakeDb {
  /** responsible_users keyed by auth_user_id (the UNIQUE column). */
  readonly responsibleByAuthUser = new Map<string, ResponsibleUserRow>();
  /** families keyed by responsible_user_id (the UNIQUE column). */
  readonly familyByResponsible = new Map<string, FamilyRow>();
  /** Monotonic id source so generated rows get stable, distinct ids. */
  private seq = 0;

  nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}-${this.seq}`;
  }
}

/** A unique-violation error shape, matching what the service narrows on. */
const uniqueViolationError = { code: UNIQUE_VIOLATION } as const;

/**
 * A minimal Supabase query-builder faithful to the slice `bootstrapMe` uses.
 * `.select()`/`.eq()` are synchronous and chainable; `.maybeSingle()` and
 * `.single()` are the awaited terminals returning `{ data, error }`.
 */
function makeQuery(db: FakeDb, table: 'responsible_users' | 'families') {
  // Pending insert payload (set by `.insert(...)`), consumed by `.single()`.
  let pendingInsert: Record<string, unknown> | null = null;
  // Equality filter (set by `.eq(...)`), consumed by `.maybeSingle()`.
  let filterValue: string | null = null;

  const builder = {
    select() {
      return builder;
    },
    eq(_column: string, value: string) {
      filterValue = value;
      return builder;
    },
    insert(payload: Record<string, unknown>) {
      pendingInsert = payload;
      return builder;
    },
    // Read terminal: `select(...).eq(...).maybeSingle()`.
    async maybeSingle<T>(): Promise<{ data: T | null; error: null }> {
      const key = filterValue;
      if (key === null) {
        return { data: null, error: null };
      }
      if (table === 'responsible_users') {
        const row = db.responsibleByAuthUser.get(key) ?? null;
        return { data: (row as unknown as T) ?? null, error: null };
      }
      const row = db.familyByResponsible.get(key) ?? null;
      return { data: (row as unknown as T) ?? null, error: null };
    },
    // Write terminal: `insert(...).select(...).single()`.
    async single<T>(): Promise<
      | { data: T; error: null }
      | { data: null; error: { code: string } }
    > {
      const payload = pendingInsert ?? {};
      if (table === 'responsible_users') {
        const authUserId = payload.auth_user_id as string;
        // Enforce UNIQUE(auth_user_id): a second insert loses the race (R1.6).
        if (db.responsibleByAuthUser.has(authUserId)) {
          return { data: null, error: { ...uniqueViolationError } };
        }
        const now = '2024-01-01T00:00:00Z';
        const row: ResponsibleUserRow = {
          id: db.nextId('resp'),
          auth_user_id: authUserId,
          name: (payload.name as string | null) ?? null,
          email: (payload.email as string | null) ?? null,
          avatar_url: (payload.avatar_url as string | null) ?? null,
          relationship: null,
          created_at: now,
          updated_at: now,
        };
        db.responsibleByAuthUser.set(authUserId, row);
        return { data: row as unknown as T, error: null };
      }

      const responsibleUserId = payload.responsible_user_id as string;
      // Enforce UNIQUE(responsible_user_id): second insert loses the race.
      if (db.familyByResponsible.has(responsibleUserId)) {
        return { data: null, error: { ...uniqueViolationError } };
      }
      const now = '2024-01-01T00:00:00Z';
      const row: FamilyRow = {
        id: db.nextId('fam'),
        responsible_user_id: responsibleUserId,
        name: (payload.name as string) ?? 'My Family',
        avatar_url: null,
        created_at: now,
        updated_at: now,
      };
      db.familyByResponsible.set(responsibleUserId, row);
      return { data: row as unknown as T, error: null };
    },
  };
  return builder;
}

/** The in-memory service-role client: just a typed `.from(table)` dispatcher. */
function makeFakeClient(db: FakeDb) {
  return {
    from(table: 'responsible_users' | 'families') {
      return makeQuery(db, table);
    },
  };
}

// Shared handle the mock reads from; reset per property run.
let currentDb: FakeDb;

// Replace the Supabase factory so the service drives our in-memory client.
vi.mock('../../src/config/supabase.js', () => ({
  getServiceRoleClient: () => makeFakeClient(currentDb),
  // Unused by bootstrap but exported by the module; inert stub.
  createUserClient: vi.fn(),
}));

const { bootstrapMe } = await import(
  '../../src/modules/auth/auth.service.js'
);

beforeEach(() => {
  currentDb = new FakeDb();
});

/** Generator for optional verified claims used only to seed a new profile. */
const claimsArb: fc.Arbitrary<AuthClaims> = fc.record(
  {
    email: fc.option(fc.string({ maxLength: 40 }), { nil: undefined }),
    name: fc.option(fc.string({ maxLength: 40 }), { nil: undefined }),
    avatarUrl: fc.option(fc.webUrl(), { nil: undefined }),
  },
  { requiredKeys: [] },
);

describe('Feature: family-task-board-backend, Property 1: Family bootstrap is idempotent', () => {
  it('N consecutive calls create exactly one responsible_users + one families row and return the same family every time', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 36 }),
        claimsArb,
        fc.integer({ min: 1, max: 8 }),
        async (authUserId, claims, callCount) => {
          currentDb = new FakeDb();

          const payloads = [];
          for (let i = 0; i < callCount; i += 1) {
            // eslint-disable-next-line no-await-in-loop
            payloads.push(await bootstrapMe(authUserId, claims));
          }

          // R1.6: exactly one row of each kind for this user.
          expect(currentDb.responsibleByAuthUser.size).toBe(1);
          expect(currentDb.familyByResponsible.size).toBe(1);

          const first = payloads[0];

          // R1.4/R1.5: every call returns the SAME composed family.
          for (const p of payloads) {
            expect(p.family.id).toBe(first.family.id);
            expect(p.family).toEqual(first.family);
            expect(p.responsibleUser).toEqual(first.responsibleUser);
          }

          // The returned family id is the single stored family's id.
          const storedFamily = [...currentDb.familyByResponsible.values()][0];
          const storedResponsible = [
            ...currentDb.responsibleByAuthUser.values(),
          ][0];
          expect(first.family.id).toBe(storedFamily.id);

          // MePayload shape: family DTO is the household row composed with the
          // responsible user's relationship + display name.
          expect(first.family).toEqual({
            id: storedFamily.id,
            name: storedFamily.name,
            avatar_url: storedFamily.avatar_url,
            relationship: storedResponsible.relationship,
            responsible_name: storedResponsible.name,
          });
          expect(first.responsibleUser).toEqual({
            id: storedResponsible.id,
            email: storedResponsible.email,
            avatar_url: storedResponsible.avatar_url,
          });
        },
      ),
      { numRuns: 200 },
    );
  });

  it('two concurrent first-login calls still yield exactly one family (loser re-selects the winner, R1.6)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 36 }),
        claimsArb,
        async (authUserId, claims) => {
          currentDb = new FakeDb();

          const [a, b] = await Promise.all([
            bootstrapMe(authUserId, claims),
            bootstrapMe(authUserId, claims),
          ]);

          // The unique constraints collapse the race to one row of each.
          expect(currentDb.responsibleByAuthUser.size).toBe(1);
          expect(currentDb.familyByResponsible.size).toBe(1);

          // Both callers observe the same family.
          expect(a.family.id).toBe(b.family.id);
          expect(a.family).toEqual(b.family);
          expect(a.responsibleUser).toEqual(b.responsibleUser);
        },
      ),
      { numRuns: 100 },
    );
  });
});
