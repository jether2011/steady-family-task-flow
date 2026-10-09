/**
 * API DTO types — the JSON shapes the HTTP layer returns to the frontend.
 *
 * Several DTOs are not 1:1 with a table:
 *   - {@link FamilyDTO} composes `families` (household) with the responsible
 *     user's `relationship` + display `responsible_name` so the frontend keeps
 *     its single "family" object (R2.2).
 *   - {@link DashboardPayload} / {@link BoardPayload} / {@link LeaderboardEntry}
 *     are read-model aggregates assembled by services.
 *
 * Field names follow the design's documented payloads: the composed family
 * object and record-like DTOs keep the DB's snake_case keys, while aggregate
 * payloads use the camelCase keys shown in the REST API tables
 * (`todayTasks`, `completedTasks`, `weekStart`, `byDay`, `byStatus`).
 */
import type {
  Relationship,
  MemberType,
  TaskStatus,
  Priority,
  RecurrenceType,
  TransactionType,
} from './enums.js';
import type { RecurrenceConfig } from './rows.js';

/**
 * Composed family object returned by `GET /me` and `GET /family`.
 * `name`/`avatar_url` come from `families`; `relationship`/`responsible_name`
 * come from `responsible_users`.
 */
export interface FamilyDTO {
  id: string;
  name: string;
  avatar_url: string | null;
  relationship: Relationship | null;
  responsible_name: string | null;
}

/** The authenticated adult, as surfaced in `GET /me`. */
export interface ResponsibleUserDTO {
  id: string;
  email: string | null;
  avatar_url: string | null;
}

/** `GET /me` bootstrap payload (creates the family if absent, R1.4). */
export interface MePayload {
  family: FamilyDTO;
  responsibleUser: ResponsibleUserDTO;
}

/** A family member as returned in `{ members: Member[] }`. */
export interface MemberDTO {
  id: string;
  family_id: string;
  name: string;
  member_type: MemberType;
  avatar_url: string | null;
  color: string | null;
  birth_year: number | null;
  active: boolean;
}

/** A task as returned in `{ task }` / `{ tasks: Task[] }`. */
export interface TaskDTO {
  id: string;
  family_id: string;
  template_id: string | null;
  title: string;
  description: string | null;
  assigned_member_id: string | null;
  created_by_user_id: string;
  status: TaskStatus;
  priority: Priority;
  points: number;
  due_date: string | null;
  due_time: string | null;
  week_start: string | null;
  carried_from_task_id: string | null;
}

/** A recurrence template as returned in `{ templates: Template[] }`. */
export interface TemplateDTO {
  id: string;
  family_id: string;
  title: string;
  description: string | null;
  assigned_member_id: string | null;
  points: number;
  priority: Priority;
  recurrence_type: RecurrenceType;
  recurrence_config: RecurrenceConfig;
  active: boolean;
}

/** A ledger entry as returned in `{ transactions: Txn[] }`. */
export interface PointsTransactionDTO {
  id: string;
  family_id: string;
  member_id: string;
  task_id: string | null;
  points: number;
  transaction_type: TransactionType;
  created_at: string;
}

/** An award as returned in `{ awards: Award[] }`. */
export interface AwardDTO {
  id: string;
  family_id: string;
  title: string;
  description: string | null;
  points_cost: number;
  icon: string;
  color: string | null;
  active: boolean;
}

/**
 * One row of `GET /family/leaderboard`:
 * `{ memberId, name, color, points, completedTasks }`.
 */
export interface LeaderboardEntry {
  memberId: string;
  name: string;
  color: string | null;
  points: number;
  completedTasks: number;
}

/**
 * `POST /tasks/:id/complete` response:
 * `{ task:{id,status:'DONE',completedAt}, completion:{completedByMemberId}, points:{awarded} }`.
 * The design's example payload includes the task `id` alongside the DONE status
 * and the completion timestamp (R8.2), so it is part of the contract.
 */
export interface CompleteTaskPayload {
  task: {
    id: string;
    status: Extract<TaskStatus, 'DONE'>;
    completedAt: string;
  };
  completion: {
    completedByMemberId: string;
  };
  points: {
    awarded: number;
  };
}

/**
 * `POST /tasks/:id/reopen` response: `{ task, reversedPoints }` (R11.1).
 *
 * Returns the FULL updated task (status back to `TODO`) so the frontend
 * `tasks.api.reopen` gets a complete `Task` — the RPC returns only the new
 * status + `reversedPoints`, so the service re-reads the task row to compose
 * this. `reversedPoints` is non-negative and is `0` when the original award was
 * 0 (no REVERSAL written, R11.5).
 */
export interface ReopenTaskPayload {
  task: TaskDTO;
  reversedPoints: number;
}

/**
 * `GET /family/dashboard`:
 * `{ family, members, todayTasks, totals:{[memberId]:points} }`.
 */
export interface DashboardPayload {
  family: FamilyDTO;
  members: MemberDTO[];
  todayTasks: TaskDTO[];
  totals: Record<string, number>;
}

/**
 * `GET /family/board?weekStart`:
 * `{ weekStart, tasks, byDay, byStatus }`. `byDay` buckets tasks by ISO date;
 * `byStatus` buckets them by board column.
 */
export interface BoardPayload {
  weekStart: string;
  tasks: TaskDTO[];
  byDay: Record<string, TaskDTO[]>;
  byStatus: Record<TaskStatus, TaskDTO[]>;
}
