import { z } from 'zod';
import { isValidIsoDate } from '../../shared/utils/dates.js';
import { TaskDTOSchema } from '../tasks/task.schemas.js';
import {
  PointsTransactionDTOSchema,
  TaskCompletionDTOSchema,
} from '../gamification/gamification.schemas.js';
const DateOnly = z.string().refine(isValidIsoDate, 'Invalid ISO calendar date');
export const HistoryFilter = z
  .object({
    memberId: z.uuid().optional(),
    from: DateOnly.optional(),
    to: DateOnly.optional(),
    type: z
      .enum(['TASK_COMPLETION', 'MANUAL_ADJUSTMENT', 'REVERSAL', 'REDEMPTION'])
      .optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().min(1).max(2000).optional(),
  })
  .strict()
  .refine((v) => !v.from || !v.to || v.from <= v.to, 'Invalid date range');
export const SummaryFilter = z
  .object({
    memberId: z.uuid().optional(),
    from: DateOnly.optional(),
    to: DateOnly.optional(),
  })
  .strict()
  .refine((v) => !v.from || !v.to || v.from <= v.to, 'Invalid date range');
export const CompletionFilter = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().min(1).max(2000).optional(),
  })
  .strict();
export const SafeMember = z.object({
  id: z.uuid(),
  name: z.string(),
  avatar_url: z.string().nullable(),
  color: z.string().nullable(),
  member_type: z.enum(['PARENT', 'CHILD', 'DEPENDENT']),
  active: z.boolean(),
});
export const SelfMember = SafeMember.extend({
  birth_year: z.number().int().nullable(),
});
export const Summary = z.object({
  earned: z.number(),
  adjustments: z.number(),
  reversed: z.number(),
  spent: z.number(),
  net: z.number(),
  balance: z.number(),
});
export const PointsPage = z.object({
  transactions: z.array(PointsTransactionDTOSchema),
  nextCursor: z.string().nullable(),
});
export const CompletionsPage = z.object({
  completions: z.array(TaskCompletionDTOSchema),
  transactions: z.array(PointsTransactionDTOSchema),
  nextCursor: z.string().nullable(),
});
export const PersonalDashboard = z.object({
  family: z.object({
    id: z.uuid(),
    name: z.string(),
    avatar_url: z.string().nullable(),
  }),
  member: SelfMember,
  balance: z.number(),
  todayTasks: z.array(TaskDTOSchema),
  upcomingTasks: z.array(TaskDTOSchema),
  recentTransactions: z.array(PointsTransactionDTOSchema),
  recentCompletions: z.array(TaskCompletionDTOSchema),
  asOf: z.string(),
});
