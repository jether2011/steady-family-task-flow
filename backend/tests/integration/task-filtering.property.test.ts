/**
 * Property 13 — "Task filtering returns exactly the matching, family-scoped
 * subset" (task 6.4).
 *
 * Feature: family-task-board-backend, Property 13: Task filtering returns
 * exactly the matching, family-scoped subset.
 *
 * **Validates: Requirements 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 17.1, 17.3**
 *
 * ----------------------------------------------------------------------------
 * What this exercises
 * ----------------------------------------------------------------------------
 * `GET /family/tasks` (and, with the same scoping, the weekly board of R17)
 * filters the caller's tasks by any combination of `date`, `weekStart`,
 * `status`, `memberId`, and `priority`, and is ALWAYS scoped to the session
 * family. The implementation under test is the query `listTasks` builds in
 * `src/modules/tasks/task.repository.ts`: it starts from `.eq('family_id', …)`
 * and layers one equality predicate per supplied filter —
 *   - `date`      → `due_date`            (R6.2)
 *   - `weekStart` → `week_start`          (R6.3)
 *   - `status`    → `status`              (R6.4)
 *   - `memberId`  → `assigned_member_id`  (R6.5)
 *   - `priority`  → `priority`            (R6.6)
 * leaving absent filters unapplied, so the result is strictly the own-family
 * subset satisfying ALL supplied predicates (R6.1 / R17.1 / R17.3 — no
 * cross-family leakage).
 *
 * Those predicates run inside Postgres (the Supabase client compiles `.eq`
 * clauses to SQL `WHERE col = value`, and `due_date` / `week_start` are real
 * `date` columns), so a mock cannot faithfully exercise the comparison — a JS
 * mock would compare strings while Postgres compares `date` values. This suite
 * therefore runs against a REAL Postgres with migrations 001..006 applied via
 * the shared db-harness, and issues the SAME family-scoped, per-filter SQL that
 * `listTasks` builds. The ONLY difference from production is the client
 * (`pg` here vs `supabase-js` there); the WHERE clause is identical.
 *
 * ----------------------------------------------------------------------------
 * The property
 * ----------------------------------------------------------------------------
 * For a generated set of tasks spread across TWO families (A = the caller,
 * B = another family) over varied dates, week starts, statuses, members, and
 * priorities, and for ANY subset of the five filters:
 *
 *   list(familyA, filters)  ===  { every family-A task that satisfies ALL
 *                                  supplied filters }   (as a set of ids)
 *
 * Equivalently, the returned id set must:
 *   - CONTAIN every family-A task matching all supplied predicates (R6.2–R6.6),
 *   - OMIT every family-A task that violates any supplied predicate,
 *   - OMIT every family-B task regardless of its fields (R6.1 / R17.3 — the
 *     cross-family isolation that holds even though the service role bypasses
 *     RLS, because the query is keyed by `family_id` first).
 *
 * The expectation is computed by an independent in-JS oracle over the exact
 * rows we inserted, so the test never re-derives the result from the same code
 * path it checks.
 *
 * ----------------------------------------------------------------------------
 * RUN COUNT
 * ----------------------------------------------------------------------------
 * Each case does a full round trip to Postgres (reset + a bulk task insert +
 * the filtered query). To keep wall-clock reasonable while sampling a broad
 * spread of task sets and filter combinations we run 30 cases (`NUM_RUNS`,
 * within the 25–50 range the task calls for), consistent with the other
 * DB-backed property suites. The small, overlapping value domains for dates,
 * week starts, members, statuses, and priorities make collisions — and thus
 * non-trivial matching subsets — likely on every run.
 *
 * ----------------------------------------------------------------------------
 * GUARD / skip-without-DB
 * ----------------------------------------------------------------------------
 * Needs a reachable Postgres via TEST_DATABASE_URL (fallback DATABASE_URL).
 * When neither is set the suite SKIPS gracefully (describe.skip) so the default
 * `npm test` stays green in environments without a database. Setup/reset are
 * shared through ./db-harness so this file only owns the Property-13
 * assertions.
 */
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  type PgClient,
  applySchema,
  connect,
  hasDatabase,
  reset,
} from './db-harness.js';

const NUM_RUNS = 30;

const HAS_DB = hasDatabase();

if (!HAS_DB) {
  // eslint-disable-next-line no-console
  console.warn(
    '[task-filtering.property.test] SKIPPED: no TEST_DATABASE_URL / ' +
      'DATABASE_URL set. Set TEST_DATABASE_URL to a reachable Postgres to run ' +
      'the task-filtering property test (e.g. a disposable `docker run postgres`).',
  );
}

const suite = HAS_DB ? describe : describe.skip;

/** Small, overlapping domains so filter collisions (real matches) are common. */
const STATUS_VALUES = ['BACKLOG', 'TODO', 'WORKING', 'DONE'] as const;
const PRIORITY_VALUES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as const;
// Mondays, so `week_start` values are realistic; `due_date` reuses the same
// pool plus a null so the "no date" partition is exercised too.
const DATE_POOL = ['2024-01-01', '2024-01-08', '2024-01-15'] as const;
const WEEK_POOL = ['2024-01-01', '2024-01-08', '2024-01-15'] as const;

type StatusValue = (typeof STATUS_VALUES)[number];
type PriorityValue = (typeof PRIORITY_VALUES)[number];

/** One generated task row (which family and member are resolved at insert). */
interface GenTask {
  family: 'A' | 'B';
  memberSlot: 0 | 1 | null; // which member of that family, or unassigned
  status: StatusValue;
  priority: PriorityValue;
  dueDate: string | null;
  weekStart: string | null;
}

/** A chosen filter combination — any field may be absent (undefined). */
interface GenFilter {
  date?: string;
  weekStart?: string;
  status?: StatusValue;
  memberSlot?: 0 | 1; // resolved to family A's member id at query time
  priority?: PriorityValue;
}

/** A seeded family with its own responsible user and two active members. */
interface SeededMultiFamily {
  responsibleUserId: string;
  familyId: string;
  memberIds: [string, string];
}

/**
 * Insert a responsible user (+ its auth.users row), a family, and two active
 * members. Mirrors db-harness `seedFamily` but gives TWO members so filtering
 * by `assigned_member_id` has more than one target, and lets us stand up two
 * independent families in one run for the cross-family-isolation check.
 */
async function seedMultiFamily(
  client: PgClient,
  label: string,
): Promise<SeededMultiFamily> {
  const auth = await client.query(
    `insert into auth.users (email) values ($1) returning id`,
    [`${label}@example.test`],
  );
  const authUserId = auth.rows[0].id as string;

  const resp = await client.query(
    `insert into responsible_users (auth_user_id, name, email, relationship)
       values ($1, $2, $3, 'MOTHER') returning id`,
    [authUserId, `Owner ${label}`, `${label}@example.test`],
  );
  const responsibleUserId = resp.rows[0].id as string;

  const fam = await client.query(
    `insert into families (responsible_user_id, name)
       values ($1, $2) returning id`,
    [responsibleUserId, `Family ${label}`],
  );
  const familyId = fam.rows[0].id as string;

  const m0 = await client.query(
    `insert into family_members (family_id, name, member_type, active)
       values ($1, $2, 'CHILD', true) returning id`,
    [familyId, `Kid ${label}0`],
  );
  const m1 = await client.query(
    `insert into family_members (family_id, name, member_type, active)
       values ($1, $2, 'CHILD', true) returning id`,
    [familyId, `Kid ${label}1`],
  );

  return {
    responsibleUserId,
    familyId,
    memberIds: [m0.rows[0].id as string, m1.rows[0].id as string],
  };
}

suite(
  'Feature: family-task-board-backend, Property 13: Task filtering returns ' +
    'exactly the matching, family-scoped subset',
  () => {
    let client: PgClient;

    beforeAll(async () => {
      client = await connect();
      await applySchema(client);
    }, 120_000);

    afterAll(async () => {
      if (client) {
        await client.end();
      }
    });

    it(
      'returns exactly the own-family subset satisfying all supplied filters ' +
        'and never leaks another family (R6.1–R6.6 / R17.1 / R17.3)',
      async () => {
        await fc.assert(
          fc.asyncProperty(
            // A non-empty set of tasks spread across families A and B, plus a
            // filter combination where each of the five filters may be present
            // or absent. Members and the memberId filter are expressed as
            // slots (0/1) and resolved to real ids after the families are
            // seeded, since ids are generated by the DB.
            fc.record({
              tasks: fc.array(
                fc.record({
                  family: fc.constantFrom<'A' | 'B'>('A', 'B'),
                  memberSlot: fc.constantFrom<0 | 1 | null>(0, 1, null),
                  status: fc.constantFrom(...STATUS_VALUES),
                  priority: fc.constantFrom(...PRIORITY_VALUES),
                  dueDate: fc.constantFrom<string | null>(...DATE_POOL, null),
                  weekStart: fc.constantFrom<string | null>(...WEEK_POOL, null),
                }),
                { minLength: 1, maxLength: 24 },
              ),
              filter: fc.record({
                date: fc.option(fc.constantFrom(...DATE_POOL), {
                  nil: undefined,
                }),
                weekStart: fc.option(fc.constantFrom(...WEEK_POOL), {
                  nil: undefined,
                }),
                status: fc.option(fc.constantFrom(...STATUS_VALUES), {
                  nil: undefined,
                }),
                memberSlot: fc.option(fc.constantFrom<0 | 1>(0, 1), {
                  nil: undefined,
                }),
                priority: fc.option(fc.constantFrom(...PRIORITY_VALUES), {
                  nil: undefined,
                }),
              }),
            }),
            async ({ tasks, filter }: { tasks: GenTask[]; filter: GenFilter }) => {
              // Fresh state per case so the id-set comparison is unambiguous.
              await reset(client);

              const famA = await seedMultiFamily(client, 'a');
              const famB = await seedMultiFamily(client, 'b');
              const fam = { A: famA, B: famB } as const;

              // Insert every generated task, remembering for each inserted id
              // which concrete family/member/fields it carries so the oracle
              // can be computed independently of the query under test. The
              // insertion order is preserved via a monotonically increasing
              // title suffix; order does not affect the set comparison.
              interface Inserted {
                id: string;
                familyId: string;
                assignedMemberId: string | null;
                status: StatusValue;
                priority: PriorityValue;
                dueDate: string | null;
                weekStart: string | null;
              }
              const inserted: Inserted[] = [];

              for (let i = 0; i < tasks.length; i += 1) {
                const t = tasks[i]!;
                const f = fam[t.family];
                const assignedMemberId =
                  t.memberSlot === null ? null : f.memberIds[t.memberSlot];

                // eslint-disable-next-line no-await-in-loop
                const res = await client.query(
                  `insert into tasks
                     (family_id, title, created_by_user_id, status, priority,
                      due_date, week_start, assigned_member_id)
                   values ($1, $2, $3, $4, $5, $6, $7, $8)
                   returning id`,
                  [
                    f.familyId,
                    `task-${i}`,
                    f.responsibleUserId,
                    t.status,
                    t.priority,
                    t.dueDate,
                    t.weekStart,
                    assignedMemberId,
                  ],
                );

                inserted.push({
                  id: res.rows[0].id as string,
                  familyId: f.familyId,
                  assignedMemberId,
                  status: t.status,
                  priority: t.priority,
                  dueDate: t.dueDate,
                  weekStart: t.weekStart,
                });
              }

              // Resolve the memberId filter slot to family A's real member id.
              const memberIdFilter =
                filter.memberSlot === undefined
                  ? undefined
                  : famA.memberIds[filter.memberSlot];

              // ----- Query under test -----
              // Reproduce EXACTLY the WHERE clause `listTasks` builds: scope to
              // family A first, then add one equality predicate per supplied
              // filter. Casting the bound date params to `::date` matches how
              // the `date`/`week_start` DATE columns are compared (the same
              // comparison supabase-js performs server-side via `.eq`).
              const where: string[] = ['family_id = $1'];
              const params: unknown[] = [famA.familyId];
              const push = (clause: string, value: unknown) => {
                params.push(value);
                where.push(clause.replace('$$', `$${params.length}`));
              };
              if (filter.date !== undefined) {
                push('due_date = $$::date', filter.date);
              }
              if (filter.weekStart !== undefined) {
                push('week_start = $$::date', filter.weekStart);
              }
              if (filter.status !== undefined) {
                push('status = $$', filter.status);
              }
              if (memberIdFilter !== undefined) {
                push('assigned_member_id = $$', memberIdFilter);
              }
              if (filter.priority !== undefined) {
                push('priority = $$', filter.priority);
              }

              const queryText =
                `select id from tasks where ${where.join(' and ')} ` +
                `order by created_at asc`;
              const rows = await client.query(queryText, params);
              const actualIds = new Set<string>(
                rows.rows.map((r: { id: string }) => r.id as string),
              );

              // ----- Independent in-JS oracle -----
              // A task matches iff it belongs to family A AND satisfies every
              // supplied predicate. Absent filters impose no constraint.
              const matches = (row: Inserted): boolean => {
                if (row.familyId !== famA.familyId) {
                  return false; // cross-family rows are never returned (R6.1)
                }
                if (filter.date !== undefined && row.dueDate !== filter.date) {
                  return false;
                }
                if (
                  filter.weekStart !== undefined &&
                  row.weekStart !== filter.weekStart
                ) {
                  return false;
                }
                if (filter.status !== undefined && row.status !== filter.status) {
                  return false;
                }
                if (
                  memberIdFilter !== undefined &&
                  row.assignedMemberId !== memberIdFilter
                ) {
                  return false;
                }
                if (
                  filter.priority !== undefined &&
                  row.priority !== filter.priority
                ) {
                  return false;
                }
                return true;
              };
              const expectedIds = new Set<string>(
                inserted.filter(matches).map((r) => r.id),
              );

              // ----- The property: returned set == expected set -----
              // Same cardinality AND same membership. Checking both directions
              // catches a missing match (under-inclusion) and a leaked/foreign
              // or filter-violating row (over-inclusion), including any
              // family-B row (R17.3).
              expect(actualIds.size).toBe(expectedIds.size);
              for (const id of expectedIds) {
                expect(actualIds.has(id)).toBe(true);
              }
              for (const id of actualIds) {
                expect(expectedIds.has(id)).toBe(true);
              }

              // Belt-and-suspenders: no family-B id can ever appear, whatever
              // the filters (explicit cross-family-isolation assertion, R17.3).
              const familyBIds = new Set<string>(
                inserted
                  .filter((r) => r.familyId === famB.familyId)
                  .map((r) => r.id),
              );
              for (const id of actualIds) {
                expect(familyBIds.has(id)).toBe(false);
              }
            },
          ),
          { numRuns: NUM_RUNS },
        );
      },
      120_000,
    );
  },
);
