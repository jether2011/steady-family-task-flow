/**
 * Property 11 — "Cross-family isolation and IDOR protection" (task 13.1).
 *
 * **Feature: family-task-board-backend, Property 11: Cross-family isolation and
 * IDOR protection**
 *
 * **Validates: Requirements 23.1, 23.2, 23.3, 23.6**
 *
 * ----------------------------------------------------------------------------
 * APPROACH — service-layer property (the documented fallback)
 * ----------------------------------------------------------------------------
 * The invariant Property 11 states ("for any resource id belonging to a
 * different family, every by-id read/mutation returns 404 NOT_FOUND without
 * disclosing the resource; and any client-supplied family_id /
 * created_by_user_id / completed_by_user_id / points / member_id is ignored or
 * rejected with 403 rather than trusted") is best *proven* at the exact code
 * boundary that enforces it — not at the HTTP edge.
 *
 * The HTTP-driven variant was evaluated and deliberately NOT taken, because the
 * backend's persistence does not go through the raw `pg` connection the
 * integration harness seeds: EVERY repository talks to Supabase via
 * `getServiceRoleClient()` (PostgREST over HTTP — see e.g.
 * `member.repository.ts`, `task.repository.ts`). Driving `buildApp()` with
 * `app.inject()` against the shared `db-harness` Postgres would therefore
 * resolve nothing (there is no PostgREST in front of that disposable DB), and
 * standing one up is far heavier than the invariant warrants. (On top of that,
 * `src/config/env.ts` calls `process.exit(1)` at import time when the Supabase
 * envs are absent, so even loading `buildApp()` needs a full env.) The
 * authorization boundary this property is about lives entirely in code, so we
 * exercise it directly and hermetically.
 *
 * The single chokepoint every by-id read/mutation funnels through is
 * `authorization.assertOwned` / `loadOwned` (`src/middleware/authorization.ts`):
 * each service loads a row by id with a repository call that is **not** scoped
 * by family, then calls `assertOwned(row?.family_id, ctx.familyId)`, which
 * collapses "missing" and "foreign family" into one `NotFound` (→ 404) so
 * existence is never leaked (R23.3). We mock each module's repository so the
 * by-id loader returns a row owned by a *different* family (family B) for ANY
 * id, with the session context fixed to family A, and assert that the real
 * service code throws `NotFound` and never returns B's row (R23.1 + R23.3).
 *
 * For R23.2 / R23.6 ("derive these fields from the session; never trust the
 * client; reject a client-supplied points/member_id with 403") the enforcement
 * is split between the Zod request schemas (`.strict()` rejects server-derived
 * keys like `family_id` / `created_by_user_id` / `points_cost`) and the atomic
 * RPC signatures (which take NO points argument, so points can only be derived
 * from the stored task/award). We assert both as universal properties over
 * fast-check-generated malicious bodies.
 *
 * No database is required, so this suite always runs and keeps `npm test`
 * green. We use >= 100 runs per property (pure in-process code).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';

import { assertOwned, loadOwned } from '../../src/middleware/authorization.js';
import { AppError, NotFound } from '../../src/shared/errors/index.js';
import type {
  AwardRow,
  FamilyMemberRow,
  TaskRow,
  TaskTemplateRow,
} from '../../src/shared/types/rows.js';
import { TaskCreate, TaskUpdate } from '../../src/modules/tasks/task.schemas.js';
import {
  AwardCreate,
  AwardUpdate,
  Redeem,
} from '../../src/modules/gamification/gamification.schemas.js';
import { TaskComplete } from '../../src/modules/completions/completion.schemas.js';

/* ------------------------------------------------------------------------- *
 * Repository mocks                                                           *
 *                                                                            *
 * Each service module imports its persistence functions by name from a       *
 * `*.repository.ts`. We replace the ONLY two kinds we need per module:        *
 *   - the by-id loader (`findXById`) — returns a family-B-owned row for ANY   *
 *     id, modelling "this id belongs to another family".                      *
 *   - every mutation / RPC — throws if reached, because the ownership guard   *
 *     MUST short-circuit before any write for a foreign id (so reaching a     *
 *     mutation would itself be an isolation bug).                             *
 *                                                                            *
 * `vi.mock` is hoisted, so the row the loaders return is read from a mutable  *
 * module-level `foreignRow*` the property body sets per run.                  *
 * ------------------------------------------------------------------------- */

/** The family-B row each by-id loader hands back; refreshed each run. */
let foreignTask: TaskRow | null = null;
let foreignMember: FamilyMemberRow | null = null;
let foreignTemplate: TaskTemplateRow | null = null;
let foreignAward: AwardRow | null = null;

/** A mutation/RPC that must never run for a foreign id. */
function unreachableMutation(name: string) {
  return (..._args: unknown[]): never => {
    throw new Error(
      `isolation bug: ${name} was reached for a foreign-family id — the ` +
        'ownership guard should have thrown NotFound first',
    );
  };
}

vi.mock('../../src/modules/tasks/task.repository.js', () => ({
  findTaskById: vi.fn(async () => foreignTask),
  updateTask: vi.fn(unreachableMutation('updateTask')),
  deleteTask: vi.fn(unreachableMutation('deleteTask')),
  moveTask: vi.fn(unreachableMutation('moveTask')),
  // `create` calls this to validate an assignee; harmless to stub as "not in
  // family" (the create IDOR assertions below don't rely on it).
  memberBelongsToFamily: vi.fn(async () => false),
  createTask: vi.fn(unreachableMutation('createTask')),
  listTasks: vi.fn(async () => []),
  findCarryOverCandidates: vi.fn(async () => []),
  findAlreadyCarried: vi.fn(async () => new Set<string>()),
  insertCarriedTasks: vi.fn(async () => []),
}));

vi.mock('../../src/modules/members/member.repository.js', () => ({
  findMemberById: vi.fn(async () => foreignMember),
  updateMember: vi.fn(unreachableMutation('updateMember')),
  deactivateMember: vi.fn(unreachableMutation('deactivateMember')),
  createMember: vi.fn(unreachableMutation('createMember')),
  listMembers: vi.fn(async () => []),
}));

vi.mock('../../src/modules/templates/template.repository.js', () => ({
  findTemplateById: vi.fn(async () => foreignTemplate),
  updateTemplate: vi.fn(unreachableMutation('updateTemplate')),
  deactivateTemplate: vi.fn(unreachableMutation('deactivateTemplate')),
  createTemplate: vi.fn(unreachableMutation('createTemplate')),
  listTemplates: vi.fn(async () => []),
  listActiveTemplates: vi.fn(async () => []),
  findExistingTemplateDueKeys: vi.fn(async () => new Set<string>()),
  insertGeneratedTask: vi.fn(unreachableMutation('insertGeneratedTask')),
}));

vi.mock('../../src/modules/gamification/gamification.repository.js', () => ({
  findAwardById: vi.fn(async () => foreignAward),
  findMemberById: vi.fn(async () => foreignMember),
  updateAward: vi.fn(unreachableMutation('updateAward')),
  deactivateAward: vi.fn(unreachableMutation('deactivateAward')),
  createAward: vi.fn(unreachableMutation('createAward')),
  listAwards: vi.fn(async () => []),
  redeemAwardRpc: vi.fn(unreachableMutation('redeemAwardRpc')),
}));

vi.mock('../../src/modules/completions/completion.repository.js', () => ({
  findTaskById: vi.fn(async () => foreignTask),
  findMemberById: vi.fn(async () => foreignMember),
  completeTaskRpc: vi.fn(unreachableMutation('completeTaskRpc')),
  reopenTaskRpc: vi.fn(unreachableMutation('reopenTaskRpc')),
}));

// Services are imported AFTER the mocks so they bind to the stubbed repos.
import * as taskService from '../../src/modules/tasks/task.service.js';
import * as memberService from '../../src/modules/members/member.service.js';
import * as templateService from '../../src/modules/templates/template.service.js';
import * as awardService from '../../src/modules/gamification/awards.service.js';
import * as completionService from '../../src/modules/completions/completion.service.js';

const NUM_RUNS = 150;

/** A v4-shaped uuid arbitrary (schemas validate `.uuid()`, so bodies need real ones). */
const uuidArb: fc.Arbitrary<string> = fc.uuid({ version: 4 });

/** Two distinct uuids: A = session family, B = the resource's (foreign) family. */
const twoFamiliesArb = fc
  .tuple(uuidArb, uuidArb)
  .filter(([a, b]) => a !== b)
  .map(([familyA, familyB]) => ({ familyA, familyB }));

/** Build a complete family-B-owned TaskRow with a chosen stored points value. */
function makeForeignTask(familyB: string, points: number): TaskRow {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    family_id: familyB,
    template_id: null,
    title: 'B secret task',
    description: 'should never be disclosed to family A',
    assigned_member_id: null,
    created_by_user_id: '22222222-2222-4222-8222-222222222222',
    status: 'TODO',
    priority: 'MEDIUM',
    points,
    due_date: null,
    due_time: null,
    week_start: null,
    carried_from_task_id: null,
    created_at: '2024-01-01T00:00:00.000Z',
    updated_at: '2024-01-01T00:00:00.000Z',
  };
}

function makeForeignMember(familyB: string): FamilyMemberRow {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    family_id: familyB,
    name: 'B secret member',
    member_type: 'CHILD',
    avatar_url: null,
    color: null,
    birth_year: null,
    active: true,
    created_at: '2024-01-01T00:00:00.000Z',
    updated_at: '2024-01-01T00:00:00.000Z',
  };
}

function makeForeignTemplate(familyB: string): TaskTemplateRow {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    family_id: familyB,
    title: 'B secret template',
    description: null,
    assigned_member_id: null,
    points: 5,
    priority: 'MEDIUM',
    recurrence_type: 'DAILY',
    recurrence_config: {},
    active: true,
    created_at: '2024-01-01T00:00:00.000Z',
    updated_at: '2024-01-01T00:00:00.000Z',
  };
}

function makeForeignAward(familyB: string, pointsCost: number): AwardRow {
  return {
    id: '55555555-5555-4555-8555-555555555555',
    family_id: familyB,
    title: 'B secret award',
    description: null,
    points_cost: pointsCost,
    icon: 'gift',
    color: null,
    active: true,
    created_at: '2024-01-01T00:00:00.000Z',
    updated_at: '2024-01-01T00:00:00.000Z',
  };
}

/**
 * Run `op` and assert it rejected with the IDOR 404 (`NotFound`, code
 * `NOT_FOUND`, http 404) and surfaced NOTHING from the foreign row. The error's
 * message is the fixed generic "Resource not found", so a resource's title /
 * id / family can never leak through it (R23.3).
 */
async function expectNotFound(op: () => Promise<unknown>): Promise<void> {
  let thrown: unknown;
  try {
    await op();
  } catch (err) {
    thrown = err;
  }
  expect(thrown, 'operation should have been denied').toBeInstanceOf(NotFound);
  const appErr = thrown as AppError;
  expect(appErr.code).toBe('NOT_FOUND');
  expect(appErr.http).toBe(404);
  // The denial message discloses nothing about the foreign resource.
  expect(appErr.message).toBe('Resource not found');
}

afterEach(() => {
  foreignTask = null;
  foreignMember = null;
  foreignTemplate = null;
  foreignAward = null;
  vi.clearAllMocks();
});

describe('Feature: family-task-board-backend, Property 11: Cross-family isolation and IDOR protection', () => {
  /* --------------------------------------------------------------------- *
   * R23.3 — every by-id read/mutation on a foreign resource → 404          *
   * (and R23.1 — a foreign row is never returned to family A).             *
   * --------------------------------------------------------------------- */
  it('denies every by-id task operation on another family\'s task with 404 and no disclosure', async () => {
    await fc.assert(
      fc.asyncProperty(
        twoFamiliesArb,
        uuidArb, // the attacker-supplied id (family B\'s), as a path param
        async ({ familyA, familyB }, foreignId) => {
          foreignTask = makeForeignTask(familyB, 10);
          const ctx = { familyId: familyA, responsibleUserId: familyA };

          // update, delete, move, complete, reopen — all by-id, all must 404.
          await expectNotFound(() =>
            taskService.update(ctx, foreignId, { title: 'hijack' }),
          );
          await expectNotFound(() => taskService.remove(ctx, foreignId));
          await expectNotFound(() =>
            taskService.move(ctx, foreignId, { status: 'WORKING' }),
          );
          await expectNotFound(() =>
            completionService.complete(ctx, foreignId, {
              completedByMemberId: '33333333-3333-4333-8333-333333333333',
            }),
          );
          await expectNotFound(() => completionService.reopen(ctx, foreignId));
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('denies by-id member operations on another family\'s member with 404', async () => {
    await fc.assert(
      fc.asyncProperty(twoFamiliesArb, uuidArb, async ({ familyA, familyB }, foreignId) => {
        foreignMember = makeForeignMember(familyB);
        const ctx = { familyId: familyA };

        await expectNotFound(() => memberService.update(ctx, foreignId, { name: 'x' }));
        await expectNotFound(() => memberService.deactivate(ctx, foreignId));
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('denies by-id template operations on another family\'s template with 404', async () => {
    await fc.assert(
      fc.asyncProperty(twoFamiliesArb, uuidArb, async ({ familyA, familyB }, foreignId) => {
        foreignTemplate = makeForeignTemplate(familyB);
        const ctx = { familyId: familyA };

        await expectNotFound(() => templateService.update(ctx, foreignId, { title: 'x' }));
        await expectNotFound(() => templateService.deactivate(ctx, foreignId));
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('denies by-id award operations on another family\'s award with 404 (before any member work)', async () => {
    await fc.assert(
      fc.asyncProperty(twoFamiliesArb, uuidArb, async ({ familyA, familyB }, foreignId) => {
        foreignAward = makeForeignAward(familyB, 7);
        // A member that WOULD be valid in family A — redeem must still 404 on
        // the award first (R18.10 precedence), never reaching the member.
        foreignMember = makeForeignMember(familyA);
        const ctx = { familyId: familyA };

        await expectNotFound(() =>
          awardService.updateAwardForFamily(ctx, foreignId, { title: 'x' }),
        );
        await expectNotFound(() => awardService.deactivateAwardForFamily(ctx, foreignId));
        await expectNotFound(() =>
          awardService.redeem(ctx, foreignId, '33333333-3333-4333-8333-333333333333'),
        );
      }),
      { numRuns: NUM_RUNS },
    );
  });

  /* --------------------------------------------------------------------- *
   * R23.1 / R23.3 — the ownership guard itself: a row is returned IFF its  *
   * family_id equals the session family; otherwise NotFound. This is the   *
   * exact predicate every service above funnels through.                   *
   * --------------------------------------------------------------------- */
  it('assertOwned/loadOwned admit a row IFF it belongs to the session family', async () => {
    await fc.assert(
      fc.asyncProperty(
        uuidArb, // ctx family
        fc.option(uuidArb, { nil: null }), // the row's family_id (may be null = "not found")
        async (ctxFamily, rowFamily) => {
          const owned = rowFamily === ctxFamily; // only exact match is owned

          if (owned) {
            // Same family → returns the row, no throw.
            const row = { family_id: rowFamily as string, id: 'r' };
            expect(assertOwned(row.family_id, ctxFamily)).toBeUndefined();
            const loaded = await loadOwned(async () => row, ctxFamily);
            expect(loaded).toBe(row);
          } else {
            // Foreign OR missing → identical NotFound (existence never leaked).
            await expectNotFound(async () => assertOwned(rowFamily, ctxFamily));
            await expectNotFound(() =>
              loadOwned(
                async () => (rowFamily === null ? null : { family_id: rowFamily, id: 'r' }),
                ctxFamily,
              ),
            );
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  /* --------------------------------------------------------------------- *
   * R23.2 — server-derived identity is never trusted from the client:      *
   * `.strict()` request schemas reject family_id / created_by_user_id /    *
   * status (create) / completed_by_user_id, so they can never be smuggled  *
   * in as a value the server would honour.                                 *
   * --------------------------------------------------------------------- */
  it('task create/update schemas reject client-supplied server-derived identity keys', () => {
    fc.assert(
      fc.property(
        uuidArb,
        uuidArb,
        fc.constantFrom(
          'family_id',
          'created_by_user_id',
          'status', // never accepted on create — server defaults it (R4.2)
          'completed_by_user_id',
          'id',
        ),
        (familyId, userId, forbiddenKey) => {
          const base = { title: 'legit task' } as Record<string, unknown>;
          base[forbiddenKey] = forbiddenKey === 'status' ? 'DONE' : familyId;

          const createResult = TaskCreate.safeParse(base);
          expect(createResult.success).toBe(false);

          // On update, family_id / created_by_user_id are likewise unknown keys
          // (status IS a legitimate update field, so skip it there).
          if (forbiddenKey !== 'status') {
            const patch = { title: 'legit', [forbiddenKey]: userId };
            const updateResult = TaskUpdate.safeParse(patch);
            expect(updateResult.success).toBe(false);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  /* --------------------------------------------------------------------- *
   * R23.6 — a client may not set points / member_id on a ledger-adjacent   *
   * create/update. The award schemas reject a client `points_cost` style   *
   * ledger field via `.strict()`, and the Redeem body `.strict()`-rejects  *
   * a client-supplied `points_cost` while REQUIRING only `memberId`; the    *
   * award cost itself is always derived from the stored row.               *
   * --------------------------------------------------------------------- */
  it('redeem body rejects a client-supplied points_cost and only accepts memberId (cost is server-derived)', () => {
    fc.assert(
      fc.property(uuidArb, fc.integer(), (memberId, bogusCost) => {
        // A clean body with just the member is accepted...
        expect(Redeem.safeParse({ memberId }).success).toBe(true);
        // ...but smuggling a points_cost (or points) is rejected by `.strict()`.
        expect(Redeem.safeParse({ memberId, points_cost: bogusCost }).success).toBe(false);
        expect(Redeem.safeParse({ memberId, points: bogusCost }).success).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('award create/update schemas reject a client-supplied family_id (ledger-owning scope is server-derived)', () => {
    fc.assert(
      fc.property(uuidArb, fc.integer({ min: 0, max: 1000 }), (familyId, cost) => {
        const create = AwardCreate.safeParse({
          title: 'reward',
          points_cost: cost,
          family_id: familyId,
        });
        expect(create.success).toBe(false);

        const update = AwardUpdate.safeParse({ points_cost: cost, family_id: familyId });
        expect(update.success).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  /* --------------------------------------------------------------------- *
   * R23.6 — completion derives `points` from the stored task, never from   *
   * the client: the complete body (`.strict()`) only accepts                *
   * `completedByMemberId`, and the atomic RPC takes NO points argument, so  *
   * the awarded amount is whatever the stored task carries. We assert the   *
   * body shape here; the amount-derivation itself is covered by Property 2. *
   * --------------------------------------------------------------------- */
  it('complete body rejects client-supplied points/completed_by_user_id and only accepts completedByMemberId', () => {
    fc.assert(
      fc.property(uuidArb, fc.integer(), uuidArb, (memberId, bogusPoints, bogusUser) => {
        expect(
          TaskComplete.safeParse({ completedByMemberId: memberId }).success,
        ).toBe(true);
        expect(
          TaskComplete.safeParse({ completedByMemberId: memberId, points: bogusPoints })
            .success,
        ).toBe(false);
        expect(
          TaskComplete.safeParse({
            completedByMemberId: memberId,
            completed_by_user_id: bogusUser,
          }).success,
        ).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
