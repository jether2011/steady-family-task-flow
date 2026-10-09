/**
 * Unit tests for the recurring-generation service (task 9.2).
 *
 * These exercise the recurrence rule mapping (R13.2–R13.6) and the in-code
 * idempotency / skip behavior (R13.7/R13.8) by mocking the repository layer, so
 * no database (or env) is involved. The repository mock stands in for the three
 * reads/writes the service depends on: `listActiveTemplates`,
 * `findExistingTemplateDueKeys`, and `insertGeneratedTask`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TaskTemplateRow } from '../../src/shared/types/index.js';
import type { GeneratedTaskInsert } from '../../src/modules/templates/template.repository.js';

const listActiveTemplates = vi.fn<[string], Promise<TaskTemplateRow[]>>();
const findExistingTemplateDueKeys =
  vi.fn<[string, string], Promise<Set<string>>>();
const insertGeneratedTask = vi.fn<[GeneratedTaskInsert], Promise<boolean>>();

// Replace the repository so the service never touches Supabase/env.
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
// 2024-01-08 is a Monday → week is Mon 01-08 .. Sun 01-14.
const WEEK_START = '2024-01-08';

function template(overrides: Partial<TaskTemplateRow>): TaskTemplateRow {
  return {
    id: 'tpl-1',
    family_id: 'fam-1',
    title: 'Chore',
    description: null,
    assigned_member_id: null,
    points: 5,
    priority: 'MEDIUM',
    recurrence_type: 'DAILY',
    recurrence_config: {},
    active: true,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  findExistingTemplateDueKeys.mockResolvedValue(new Set());
  insertGeneratedTask.mockResolvedValue(true);
});

describe('generate — recurrence rules (R13.2–R13.5)', () => {
  it('DAILY generates on all seven dates', async () => {
    listActiveTemplates.mockResolvedValue([template({ recurrence_type: 'DAILY' })]);

    const result = await generate(CTX, WEEK_START);

    expect(result).toEqual({ weekStart: WEEK_START, created: 7 });
    expect(insertGeneratedTask).toHaveBeenCalledTimes(7);
  });

  it('WEEKDAYS generates only Monday–Friday (5 dates)', async () => {
    listActiveTemplates.mockResolvedValue([
      template({ recurrence_type: 'WEEKDAYS' }),
    ]);

    const result = await generate(CTX, WEEK_START);

    expect(result.created).toBe(5);
    const dueDates = insertGeneratedTask.mock.calls.map((c) => c[0].dueDate);
    expect(dueDates).toEqual([
      '2024-01-08',
      '2024-01-09',
      '2024-01-10',
      '2024-01-11',
      '2024-01-12',
    ]);
  });

  it('WEEKLY generates only on Monday (1 date)', async () => {
    listActiveTemplates.mockResolvedValue([
      template({ recurrence_type: 'WEEKLY' }),
    ]);

    const result = await generate(CTX, WEEK_START);

    expect(result.created).toBe(1);
    expect(insertGeneratedTask.mock.calls[0][0].dueDate).toBe('2024-01-08');
  });

  it('CUSTOM generates only on the configured weekday numbers', async () => {
    // days [0,6] → Sunday + Saturday of this week: 01-14 and 01-13.
    listActiveTemplates.mockResolvedValue([
      template({ recurrence_type: 'CUSTOM', recurrence_config: { days: [0, 6] } }),
    ]);

    const result = await generate(CTX, WEEK_START);

    expect(result.created).toBe(2);
    const dueDates = insertGeneratedTask.mock.calls.map((c) => c[0].dueDate).sort();
    expect(dueDates).toEqual(['2024-01-13', '2024-01-14']);
  });

  it('CUSTOM with empty days generates nothing', async () => {
    listActiveTemplates.mockResolvedValue([
      template({ recurrence_type: 'CUSTOM', recurrence_config: { days: [] } }),
    ]);

    const result = await generate(CTX, WEEK_START);

    expect(result.created).toBe(0);
    expect(insertGeneratedTask).not.toHaveBeenCalled();
  });
});

describe('generate — idempotency (R13.7/R13.8)', () => {
  it('skips dates whose (template_id, due_date) already exists and does not count them', async () => {
    listActiveTemplates.mockResolvedValue([
      template({ id: 'tpl-1', recurrence_type: 'DAILY' }),
    ]);
    // Monday and Tuesday already generated.
    findExistingTemplateDueKeys.mockResolvedValue(
      new Set(['tpl-1|2024-01-08', 'tpl-1|2024-01-09']),
    );

    const result = await generate(CTX, WEEK_START);

    expect(result.created).toBe(5);
    expect(insertGeneratedTask).toHaveBeenCalledTimes(5);
  });

  it('returns created 0 when every date already exists (re-run)', async () => {
    listActiveTemplates.mockResolvedValue([
      template({ id: 'tpl-1', recurrence_type: 'WEEKLY' }),
    ]);
    findExistingTemplateDueKeys.mockResolvedValue(new Set(['tpl-1|2024-01-08']));

    const result = await generate(CTX, WEEK_START);

    expect(result).toEqual({ weekStart: WEEK_START, created: 0 });
    expect(insertGeneratedTask).not.toHaveBeenCalled();
  });

  it('does not count a row the DB rejected as a duplicate (insert returns false)', async () => {
    listActiveTemplates.mockResolvedValue([
      template({ id: 'tpl-1', recurrence_type: 'WEEKDAYS' }),
    ]);
    // First insert races and is rejected by the unique index; rest succeed.
    insertGeneratedTask
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);

    const result = await generate(CTX, WEEK_START);

    // 5 due dates, 1 lost to the backstop → 4 counted.
    expect(result.created).toBe(4);
    expect(insertGeneratedTask).toHaveBeenCalledTimes(5);
  });

  it('derives insert fields from the template and session context', async () => {
    listActiveTemplates.mockResolvedValue([
      template({
        id: 'tpl-9',
        title: 'Dishes',
        description: 'After dinner',
        assigned_member_id: 'mem-3',
        points: 10,
        priority: 'HIGH',
        recurrence_type: 'WEEKLY',
      }),
    ]);

    await generate(CTX, WEEK_START);

    expect(insertGeneratedTask).toHaveBeenCalledWith({
      familyId: 'fam-1',
      templateId: 'tpl-9',
      createdByUserId: 'user-1',
      title: 'Dishes',
      description: 'After dinner',
      assignedMemberId: 'mem-3',
      points: 10,
      priority: 'HIGH',
      dueDate: '2024-01-08',
      weekStart: WEEK_START,
    });
  });
});
