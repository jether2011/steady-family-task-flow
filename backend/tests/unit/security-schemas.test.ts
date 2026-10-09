/**
 * Point-manipulation + CORS/validation security tests — the NO-DATABASE half of
 * task 13.2 (R23.2, R23.4, R23.6, R29.8).
 *
 * This suite proves, without any database, the two code-level guards that stop a
 * client from writing the points ledger or widening CORS:
 *
 *   1. STRICT-SCHEMA REJECTIONS (R23.2 / R23.6, surfaced as `422 VALIDATION`).
 *      Every create/update/action body is a `.strict()` Zod object whose keys
 *      are ONLY the client-settable fields. Server-derived fields —
 *      `family_id`, `created_by_user_id`, `status` (on create), `points`,
 *      `points_cost`, `member_id`/`memberId` where the server derives it, and
 *      the completion's own point award — are not declared, so `.strict()`
 *      rejects any body that smuggles them. Because the routes attach these
 *      schemas via `fastify-type-provider-zod`, a `safeParse` failure here is
 *      exactly the pre-handler rejection the API returns as `422` (R25.2),
 *      which is why a client can never supply `points`/`member_id` on
 *      create/update. (The task description's "403 FORBIDDEN" names the broader
 *      outcome; the schema layer specifically closes the door at `422` before a
 *      handler ever runs, and the completion service additionally returns `403`
 *      for a cross-family member — asserted separately in the integration/IDOR
 *      suites.)
 *
 *   2. CORS NEVER EMITS `*` IN PRODUCTION (R29.8). `resolveCorsOrigin` returns
 *      the explicit allowlist with any wildcard stripped when `NODE_ENV` is
 *      `production`, so even a misconfigured `CORS_ORIGIN=...,*` cannot open the
 *      API to every origin. Outside production it reflects the caller's origin
 *      (never a bare `*`).
 *
 * The matching RLS-level proof — that `points_transactions` / `task_completions`
 * have NO user-role write policy, so the ledger is service-role-only — lives in
 * `tests/integration/ledger-write-denial.test.ts` (DB-guarded).
 */
import { randomUUID } from 'node:crypto';

import { beforeAll, describe, expect, it } from 'vitest';

import {
  TaskCreate,
  TaskUpdate,
} from '../../src/modules/tasks/task.schemas.js';
import { TaskComplete } from '../../src/modules/completions/completion.schemas.js';
import {
  AwardCreate,
  AwardUpdate,
  Redeem,
} from '../../src/modules/gamification/gamification.schemas.js';

// `src/app.ts` imports `src/config/env.ts`, which eagerly validates the
// environment at import time and calls `process.exit(1)` if anything required is
// missing. Populate a complete, valid dummy env BEFORE dynamically importing the
// CORS helper so the module loads cleanly in the test runner (same pattern as
// env.test.ts). These values are never used for real network calls here.
let resolveCorsOrigin: typeof import('../../src/app.js').resolveCorsOrigin;

beforeAll(async () => {
  process.env.PORT ??= '8080';
  process.env.NODE_ENV ??= 'test';
  process.env.SUPABASE_URL ??= 'https://project.supabase.co';
  process.env.SUPABASE_ANON_KEY ??= 'dummy-anon-key';
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'dummy-service-role-key';
  process.env.CORS_ORIGIN ??= 'https://app.example.com';

  ({ resolveCorsOrigin } = await import('../../src/app.js'));
});

/* ------------------------------------------------------------------------- *
 * 1. Strict-schema rejection of client-supplied server-derived fields        *
 *    (R23.2 / R23.6 → 422 VALIDATION)                                        *
 * ------------------------------------------------------------------------- */

describe('TaskCreate rejects client-supplied server-derived fields (R23.2/R23.6)', () => {
  // A minimal valid create body: only client-settable fields.
  const validCreate = { title: 'Clean room' };

  it('accepts a body with only client-settable fields', () => {
    expect(TaskCreate.safeParse(validCreate).success).toBe(true);
  });

  it.each([
    ['family_id', { family_id: randomUUID() }],
    ['created_by_user_id', { created_by_user_id: randomUUID() }],
    ['status', { status: 'DONE' }],
  ])('rejects a create body carrying the server-derived field %s', (_label, extra) => {
    // `family_id`, `created_by_user_id`, and `status` are NOT declared on
    // TaskCreate (status defaults to TODO at the DB level), so `.strict()`
    // rejects any create body that tries to set them (R4.2/R23.2).
    expect(TaskCreate.safeParse({ ...validCreate, ...extra }).success).toBe(
      false,
    );
  });
});

describe('TaskUpdate rejects client-supplied server-derived fields (R23.2)', () => {
  it('accepts a partial update of a client-settable field', () => {
    expect(TaskUpdate.safeParse({ title: 'Renamed' }).success).toBe(true);
  });

  it.each([
    ['family_id', { family_id: randomUUID() }],
    ['created_by_user_id', { created_by_user_id: randomUUID() }],
  ])('rejects an update body carrying %s', (_label, extra) => {
    expect(TaskUpdate.safeParse(extra).success).toBe(false);
  });
});

describe('TaskComplete accepts ONLY completedByMemberId (R23.6)', () => {
  const validMember = randomUUID();

  it('accepts the single allowed key', () => {
    expect(
      TaskComplete.safeParse({ completedByMemberId: validMember }).success,
    ).toBe(true);
  });

  it.each([
    ['points', { points: 500 }],
    ['family_id', { family_id: randomUUID() }],
    ['completed_by_user_id', { completed_by_user_id: randomUUID() }],
    ['member_id (wrong key for a smuggled id)', { member_id: randomUUID() }],
  ])('rejects a completion body carrying %s', (_label, extra) => {
    expect(
      TaskComplete.safeParse({
        completedByMemberId: validMember,
        ...extra,
      }).success,
    ).toBe(false);
  });

  it('rejects a completion body that omits the required member and only smuggles points', () => {
    expect(TaskComplete.safeParse({ points: 500 }).success).toBe(false);
  });
});

describe('Award schemas reject client-supplied server-derived fields (R23.2/R23.4)', () => {
  const validAwardCreate = { title: 'Ice cream', points_cost: 100 };

  it('accepts a valid award create body', () => {
    expect(AwardCreate.safeParse(validAwardCreate).success).toBe(true);
  });

  it.each([
    ['family_id', { family_id: randomUUID() }],
    ['active', { active: true }],
  ])('AwardCreate rejects a body carrying %s', (_label, extra) => {
    expect(
      AwardCreate.safeParse({ ...validAwardCreate, ...extra }).success,
    ).toBe(false);
  });

  it('AwardUpdate rejects a client-supplied family_id', () => {
    expect(
      AwardUpdate.safeParse({
        title: 'Renamed',
        family_id: randomUUID(),
      }).success,
    ).toBe(false);
  });

  it('Redeem accepts ONLY memberId and rejects a smuggled points_cost / points (R18.6)', () => {
    const validMember = randomUUID();
    expect(Redeem.safeParse({ memberId: validMember }).success).toBe(true);

    for (const extra of [{ points_cost: 0 }, { points: 0 }]) {
      expect(
        Redeem.safeParse({ memberId: validMember, ...extra }).success,
      ).toBe(false);
    }
  });
});

/* ------------------------------------------------------------------------- *
 * 2. CORS never emits `*` in production (R29.8)                              *
 * ------------------------------------------------------------------------- */

describe('resolveCorsOrigin refuses `*` in production (R29.8)', () => {
  it('strips a wildcard from the production allowlist', () => {
    const origin = resolveCorsOrigin({
      NODE_ENV: 'production',
      corsOrigins: ['https://app.example.com', '*'],
    });
    expect(Array.isArray(origin)).toBe(true);
    expect(origin).toEqual(['https://app.example.com']);
    expect(origin).not.toContain('*');
  });

  it('never returns a bare `*` even when the whole allowlist is wildcard in production', () => {
    const origin = resolveCorsOrigin({
      NODE_ENV: 'production',
      corsOrigins: ['*'],
    });
    // All wildcards stripped → an empty allowlist (which @fastify/cors treats as
    // "no origin allowed"), never `*` and never `true` (reflect-any).
    expect(origin).toEqual([]);
    expect(origin).not.toBe(true);
  });

  it('returns the explicit allowlist unchanged in production when no wildcard is present', () => {
    const origin = resolveCorsOrigin({
      NODE_ENV: 'production',
      corsOrigins: ['https://a.example.com', 'https://b.example.com'],
    });
    expect(origin).toEqual(['https://a.example.com', 'https://b.example.com']);
  });

  it('reflects the caller origin (never a bare `*`) outside production', () => {
    const origin = resolveCorsOrigin({
      NODE_ENV: 'development',
      corsOrigins: ['*'],
    });
    expect(origin).toBe(true);
    expect(origin).not.toBe('*');
  });
});
