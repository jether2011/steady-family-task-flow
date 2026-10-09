/**
 * Property 7 (task 9.4): recurring generation is correct and idempotent.
 *
 * For any set of active Task_Templates and any valid Monday `weekStart`, the
 * first `generate()` call creates a Task for exactly those (template, date)
 * pairs whose UTC weekday satisfies the template's recurrence rule
 * (DAILY = all 7, WEEKDAYS = Mon–Fri, WEEKLY = Mon, CUSTOM =
 * `recurrence_config.days`), computed in UTC (R13.2–R13.6). A second call on the
 * same unchanged state creates nothing (`created` = 0) and leaves the generated
 * task set identical (R13.7/R13.8).
 *
 * This is a SERVICE-level property test. The repository
 * (`template.repository.js`) is mocked exactly as the example-based
 * `template-generate.service.test.ts` does it, so no database/env is involved.
 * On top of that mock we layer a stateful in-memory "DB": a `Set` of existing
 * `${template_id}|${due_date}` keys. `findExistingTemplateDueKeys` returns the
 * current set; `insertGeneratedTask` adds the key and returns `true` when new /
 * `false` when it already existed — mirroring the real partial
 * `UNIQUE(template_id, due_date)` index and its idempotency backstop.
 *
 * The expected set is computed independently (from the recurrence rule + UTC
 * weekday math) and compared against what the service actually inserted, so the
 * test does not just re-run the implementation's own branching.
 */
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  RecurrenceType,
  TaskTemplateRow,
} from '../../src/shared/types/index.js';
import type { GeneratedTaskInsert } from '../../src/modules/templates/template.repository.js';
import { utcWeekday, weekDates } from '../../src/shared/utils/dates.js';

const NUM_RUNS = 200;

const listActiveTemplates = vi.fn<[string], Promise<TaskTemplateRow[]>>();
const findExistingTemplateDueKeys =
  vi.fn<[string, string], Promise<Set<string>>>();
const insertGeneratedTask = vi.fn<[GeneratedTaskInsert], Promise<boolean>>();

// Replace the repository so the service never touches Supabase/env — same
// pattern as tests/unit/template-generate.service.test.ts.
vi.mock('../../src/modules/templates/template.repository.js', () => ({
  listActiveTemplates: (familyId: string) => listActiveTemplates(familyId),
  findExistingTemplateDueKeys: (familyId: string, weekStart: string) =>
    findExistingTemplateDueKeys(familyId, weekStart),
  insertGeneratedTask: (insert: GeneratedTaskInsert) =>
    insertGeneratedTask(insert),
  // Unused by generate() but imported by the service module barrel path.
  createTemplate: vi.fn(),
  deactivateTemplate: vi.fn(),
  findTemplateById: vi.fn(),
  listTemplates: vi.fn(),
  updateTemplate: vi.fn(),
}));

const { generate } = await import(
  '../../src/modules/templates/template.service.js'
);

const CTX = { familyId: 'fam-1', responsibleUserId: 'user-1' };

/**
 * The stateful in-memory "DB": the set of `${template_id}|${due_date}` keys for
 * tasks that already exist. Reset per property run. `findExistingTemplateDueKeys`
 * reads it; `insertGeneratedTask` mutates it.
 */
let existingKeys: Set<string>;

/**
 * Wire the repository mocks to the shared `existingKeys` set so the service sees
 * a consistent, mutating store across both generate() calls — faithfully
 * reproducing the real DB + unique-index behaviour.
 */
function wireStatefulDb(): void {
  // Return a fresh copy each read so the service's local "seen" set is a
  // snapshot, exactly like the real query result.
  findExistingTemplateDueKeys.mockImplementation(async () => new Set(existingKeys));
  insertGeneratedTask.mockImplementation(async (insert) => {
    const key = `${insert.templateId}|${insert.dueDate}`;
    if (existingKeys.has(key)) {
      return false; // unique-index backstop: already present → not newly created
    }
    existingKeys.add(key);
    return true;
  });
}

/* ----------------------------- Generators ------------------------------- */

/**
 * A valid `YYYY-MM-DD` UTC Monday within a few years of 2024. Derived from an
 * epoch-day offset so every value is a real calendar date, then snapped back to
 * the Monday of its week via its UTC weekday.
 */
const mondayIso: fc.Arbitrary<string> = fc
  .integer({ min: -3650, max: 3650 })
  .map((offsetDays) => {
    const d = new Date(Date.UTC(2024, 0, 1));
    d.setUTCDate(d.getUTCDate() + offsetDays);
    // Snap to Monday of this date's week (UTC): Sunday=0 → back 6, else back (wd-1).
    const wd = d.getUTCDay();
    const backToMonday = wd === 0 ? 6 : wd - 1;
    d.setUTCDate(d.getUTCDate() - backToMonday);
    return d.toISOString().slice(0, 10);
  });

const recurrenceType: fc.Arbitrary<RecurrenceType> = fc.constantFrom(
  'DAILY',
  'WEEKDAYS',
  'WEEKLY',
  'CUSTOM',
);

/** A `recurrence_config.days` subset of 0..6 (deduped), possibly empty. */
const customDays: fc.Arbitrary<number[]> = fc
  .uniqueArray(fc.integer({ min: 0, max: 6 }), { minLength: 0, maxLength: 7 });

/**
 * One active template with a random recurrence rule. CUSTOM carries a random
 * `days` subset; the others get an empty config (the service ignores it).
 */
const templateArb: fc.Arbitrary<TaskTemplateRow> = fc
  .record({
    id: fc.uuid(),
    type: recurrenceType,
    days: customDays,
  })
  .map(({ id, type, days }) => ({
    id,
    family_id: CTX.familyId,
    title: 'Chore',
    description: null,
    assigned_member_id: null,
    points: 5,
    priority: 'MEDIUM',
    recurrence_type: type,
    recurrence_config: type === 'CUSTOM' ? { days } : {},
    active: true,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  }));

/**
 * A set of active templates with distinct ids (so each (template, date) pair is
 * uniquely keyed, matching the real `UNIQUE(template_id, due_date)` index).
 */
const templatesArb: fc.Arbitrary<TaskTemplateRow[]> = fc
  .uniqueArray(templateArb, {
    minLength: 0,
    maxLength: 6,
    selector: (t) => t.id,
  });

/* ----------------- Independent expected-set computation ----------------- */

const MONDAY = 1;
const FRIDAY = 5;

/** Mirror of the recurrence rule (R13.2–R13.6), computed independently. */
function isDue(type: RecurrenceType, days: number[], weekday: number): boolean {
  switch (type) {
    case 'DAILY':
      return true;
    case 'WEEKDAYS':
      return weekday >= MONDAY && weekday <= FRIDAY;
    case 'WEEKLY':
      return weekday === MONDAY;
    case 'CUSTOM':
      return days.includes(weekday);
    default:
      return false;
  }
}

/**
 * The expected set of `${template_id}|${due_date}` keys for a week, derived
 * independently from the recurrence rule and UTC weekday of each of the seven
 * dates.
 */
function expectedKeys(
  templates: TaskTemplateRow[],
  weekStart: string,
): Set<string> {
  const dates = weekDates(weekStart);
  const keys = new Set<string>();
  for (const t of templates) {
    const days = t.recurrence_config?.days ?? [];
    for (const date of dates) {
      if (isDue(t.recurrence_type, days, utcWeekday(date))) {
        keys.add(`${t.id}|${date}`);
      }
    }
  }
  return keys;
}

/** Keys actually passed to insertGeneratedTask across all its calls. */
function insertedKeys(): Set<string> {
  return new Set(
    insertGeneratedTask.mock.calls.map(
      ([insert]) => `${insert.templateId}|${insert.dueDate}`,
    ),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  existingKeys = new Set<string>();
  wireStatefulDb();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('Feature: family-task-board-backend, Property 7: Recurring generation is correct and idempotent', () => {
  it('first generation creates exactly the (template, date) pairs the recurrence rule allows (R13.2–R13.6)', async () => {
    await fc.assert(
      fc.asyncProperty(templatesArb, mondayIso, async (templates, weekStart) => {
        // Fresh store + mocks for this run.
        existingKeys = new Set<string>();
        vi.clearAllMocks();
        wireStatefulDb();
        listActiveTemplates.mockResolvedValue(templates);

        const expected = expectedKeys(templates, weekStart);

        const result = await generate(CTX, weekStart);

        // created counts exactly the newly-inserted (template, date) pairs.
        expect(result.weekStart).toBe(weekStart);
        expect(result.created).toBe(expected.size);

        // The set of inserted keys equals the independently-computed expected set.
        const actual = insertedKeys();
        expect(actual).toEqual(expected);

        // The in-memory DB now holds exactly those keys.
        expect(existingKeys).toEqual(expected);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('a second generation on the unchanged state creates nothing and leaves the task set identical (R13.7/R13.8)', async () => {
    await fc.assert(
      fc.asyncProperty(templatesArb, mondayIso, async (templates, weekStart) => {
        existingKeys = new Set<string>();
        vi.clearAllMocks();
        wireStatefulDb();
        listActiveTemplates.mockResolvedValue(templates);

        const first = await generate(CTX, weekStart);
        const afterFirst = new Set(existingKeys);

        // Reset only the call history so the second run's inserts are isolated;
        // the store (existingKeys) is intentionally carried over unchanged.
        insertGeneratedTask.mockClear();

        const second = await generate(CTX, weekStart);

        // Idempotency: the re-run creates nothing...
        expect(second.created).toBe(0);
        // ...performs no new inserts...
        expect(insertedKeys().size).toBe(0);
        // ...and the task set is byte-for-byte identical to after the first run.
        expect(existingKeys).toEqual(afterFirst);
        // Sanity: the first run itself was consistent with the expected set.
        expect(first.created).toBe(afterFirst.size);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
