/**
 * Shared DTO types for the Family Task Board REST API (`/api/v1`).
 *
 * These mirror the backend response/payload shapes described in the design's
 * "REST API Design" section. Field names match the Supabase column names used
 * by the backend (snake_case) so the existing `.jsx` pages/components keep
 * their current property access unchanged (DP-1).
 *
 * Enums are string-literal unions matching the TEXT ... CHECK constraints in
 * the backend schema.
 */

// ---------------------------------------------------------------------------
// Enums (string-literal unions)
// ---------------------------------------------------------------------------

export type Relationship = 'FATHER' | 'MOTHER' | 'GUARDIAN' | 'OTHER';
export type MemberType = 'PARENT' | 'CHILD' | 'DEPENDENT';
export type TaskStatus = 'BACKLOG' | 'TODO' | 'WORKING' | 'DONE';
export type Priority = 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
export type RecurrenceType = 'DAILY' | 'WEEKDAYS' | 'WEEKLY' | 'CUSTOM';
export type TransactionType =
  | 'TASK_COMPLETION'
  | 'MANUAL_ADJUSTMENT'
  | 'REVERSAL'
  | 'REDEMPTION';

/** Leaderboard period query values. */
export type LeaderboardPeriod = 'today' | 'week' | 'month' | 'all';

/** Movable board columns (DONE is reached only via the completion endpoint). */
export type MovableStatus = Exclude<TaskStatus, 'DONE'>;

// ---------------------------------------------------------------------------
// Core entity DTOs
// ---------------------------------------------------------------------------

/**
 * Composed family DTO returned by `GET /me` and `GET/PATCH /family`.
 *
 * The backend splits household data (`families`) from the responsible adult
 * (`responsible_users`), but composes a single flat object here so the
 * frontend keeps its single "family" mental model (design: responsible_users /
 * families -> single frontend "family" object).
 */
export interface Family {
  id: string;
  name: string; // families.name
  avatar_url: string | null; // families.avatar_url
  relationship: Relationship | null; // responsible_users.relationship
  responsible_name: string | null; // responsible_users.name
}

/** Responsible (authenticated) user profile returned alongside the family. */
export interface ResponsibleUser {
  id: string;
  email: string | null;
  avatar_url: string | null;
}

/** `GET /me` payload: profile + family (family created on first login). */
export interface MePayload {
  family: Family;
  responsibleUser: ResponsibleUser;
}

/** A household participant. Members have no login (database records only). */
export interface Member {
  id: string;
  family_id: string;
  name: string;
  member_type: MemberType;
  avatar_url: string | null;
  color: string | null;
  birth_year: number | null;
  active: boolean;
  created_at: string;
  updated_at: string;
}

/** A task on the board. */
export interface Task {
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
  created_at: string;
  updated_at: string;
}

/** Recurrence configuration (used by CUSTOM templates). */
export interface RecurrenceConfig {
  days?: number[]; // weekday numbers 0 (Sun) .. 6 (Sat)
}

/** A recurring task template. */
export interface TaskTemplate {
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
  created_at: string;
  updated_at: string;
}

/** An append-only points-ledger entry. */
export interface PointsTransaction {
  id: string;
  family_id: string;
  member_id: string;
  task_id: string | null;
  points: number; // may be negative (REVERSAL / REDEMPTION)
  transaction_type: TransactionType;
  created_at: string;
}

/** A record that a member completed a task. */
export interface TaskCompletion {
  id: string;
  task_id: string;
  family_id: string;
  completed_by_user_id: string;
  completed_by_member_id: string;
  completed_at: string;
}

/** A redeemable reward. */
export interface Award {
  id: string;
  family_id: string;
  title: string;
  description: string | null;
  points_cost: number;
  icon: string;
  color: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Aggregate / view DTOs
// ---------------------------------------------------------------------------

/** One row of the leaderboard. */
export interface LeaderboardEntry {
  memberId: string;
  name: string;
  color: string | null;
  points: number;
  completedTasks: number;
}

/** `GET /family/leaderboard` payload. */
export interface LeaderboardPayload {
  entries: LeaderboardEntry[];
}

/**
 * `GET /family/dashboard` aggregate payload.
 * `totals` maps a member id to that member's current derived point total.
 */
export interface DashboardPayload {
  family: Family;
  members: Member[];
  todayTasks: Task[];
  totals: Record<string, number>;
}

/** `GET /family/board` payload for a selected week. */
export interface BoardPayload {
  weekStart: string;
  tasks: Task[];
  byDay: Record<string, Task[]>; // keyed by ISO date (YYYY-MM-DD)
  byStatus: Record<TaskStatus, Task[]>;
}

/** `GET /family/members/:id/completions` member-profile payload. */
export interface MemberProfilePayload {
  completions: TaskCompletion[];
  transactions: PointsTransaction[];
}

/** `POST /tasks/:id/complete` payload. */
export interface CompleteTaskPayload {
  task: { status: 'DONE'; completedAt: string };
  completion: { completedByMemberId: string };
  points: { awarded: number };
}

/** `POST /tasks/:id/reopen` payload. */
export interface ReopenTaskPayload {
  task: Task;
  reversedPoints: number;
}

// ---------------------------------------------------------------------------
// Request payload / filter shapes
// ---------------------------------------------------------------------------

/** `PATCH /family` body (flat shape; backend routes fields to the right table). */
export interface FamilyUpdate {
  name?: string;
  avatar_url?: string | null;
  relationship?: Relationship;
  responsible_name?: string;
}

export interface MemberCreate {
  name: string;
  member_type: MemberType;
  avatar_url?: string | null;
  color?: string | null;
  birth_year?: number | null;
}

export type MemberUpdate = Partial<MemberCreate> & { active?: boolean };

export interface TaskFilter {
  date?: string;
  weekStart?: string;
  status?: TaskStatus;
  memberId?: string;
  priority?: Priority;
}

export interface TaskCreate {
  title: string;
  description?: string | null;
  assigned_member_id?: string | null;
  priority?: Priority;
  points?: number;
  due_date?: string | null;
  due_time?: string | null;
  week_start?: string | null;
}

export type TaskUpdate = Partial<TaskCreate> & { status?: TaskStatus };

export interface TaskMove {
  status: MovableStatus;
}

export interface TaskComplete {
  completedByMemberId: string;
}

export interface CarryOver {
  targetDate?: string;
  targetWeekStart?: string;
}

export interface TemplateCreate {
  title: string;
  description?: string | null;
  assigned_member_id?: string | null;
  points?: number;
  priority?: Priority;
  recurrence_type: RecurrenceType;
  recurrence_config?: RecurrenceConfig;
}

export type TemplateUpdate = Partial<TemplateCreate> & { active?: boolean };

export interface GenerateRecurring {
  weekStart: string;
}

export interface GenerateRecurringResult {
  weekStart: string;
  created: number;
}

export interface CarryOverResult {
  created: number;
}

export interface AwardCreate {
  title: string;
  points_cost: number;
  description?: string | null;
  icon?: string;
  color?: string | null;
}

export type AwardUpdate = Partial<AwardCreate> & { active?: boolean };

export interface Redeem {
  memberId: string;
}

export interface PointsFilter {
  memberId?: string;
  from?: string;
  to?: string;
}
