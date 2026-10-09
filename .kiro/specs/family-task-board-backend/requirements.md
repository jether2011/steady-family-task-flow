# Requirements Document

## Introduction

The Family Task Board is an application where exactly one authenticated adult (the RESPONSIBLE user) manages chores, tasks, points, and rewards for a household. Family members (children, parents, dependents) are database records only — they have no logins. The RESPONSIBLE user records which member completed each task, and the system awards points through an append-only ledger that drives leaderboards and reward redemption.

Today the frontend (React 18 + Vite + Tailwind + TanStack Query, written in `.jsx`) runs entirely on the Base44 SDK: it uses `base44.entities.*` for data access, `base44.functions.invoke(...)` for three server functions (`completeTask`, `reopenTask`, `generateRecurring`), and `base44.auth` for authentication. The `backend/` directory is empty.

This feature delivers two things end-to-end:

1. **A production-ready Node.js + Supabase backend** exposing a versioned REST API (`/api/v1`) that reproduces and hardens all existing Base44 business logic, backed by Supabase PostgreSQL with Row-Level Security (RLS), Supabase Auth (Google OAuth), Realtime, reproducible SQL migrations, and seed data.
2. **A frontend migration** that removes the Base44 SDK, replaces the data layer with a typed REST client wired through TanStack Query, adds Google OAuth session handling, realtime cache invalidation, optimistic task completion, and a landscape Wall Mode.

The result must install, build, and test cleanly for both apps and be independently deployable (Frontend → Node.js Backend API → Supabase).

### Decision Points and Assumptions

Three discrepancies between the implementation brief and the current codebase were flagged and have been resolved into the confirmed decisions below. Each is captured as an explicit decision that drives requirements.

- **DP-1 (Frontend language/structure):** The brief targets a TypeScript frontend with an `app/ pages/ features/ api/` structure; the current frontend is `.jsx`. **Confirmed:** the migration keeps the existing `.jsx` structure and performs a data-layer swap only (Base44 SDK → typed REST client), while the REST client module and its types are authored in TypeScript (`.ts`) since a `tsc` typecheck script already exists. A full `.jsx → .tsx` rewrite is explicitly out of scope. See Requirement 24.
- **DP-2 (Awards and extra pages not in the brief):** The backend brief omits Awards, Points History, Onboarding, and Member Profile, but these exist in the frontend. **Confirmed:** all extra features and pages are kept — Awards (CRUD plus points redemption), Points History, Onboarding, and Member Profile are in scope for parity. See Requirements 18 and 20.
- **DP-3 (Auth method conflict):** Email/password auth pages (Register, ForgotPassword, ResetPassword) exist, but the brief mandates Google OAuth only, with exactly one RESPONSIBLE user per family. **Confirmed:** Google OAuth is the only supported authentication method; email/password pages and routes are removed from the frontend and no email/password endpoints are implemented. See Requirement 1.

## Glossary

- **RESPONSIBLE_User**: The single authenticated human who owns and manages one family account. Authenticates via Google OAuth. Has a `relationship` of FATHER, MOTHER, GUARDIAN, or OTHER.
- **Family**: The top-level household record owned by exactly one RESPONSIBLE_User.
- **Family_Member**: A database record representing a household participant (member_type PARENT, CHILD, or DEPENDENT). A Family_Member has no account, no login, no email, and no password.
- **Backend**: The Node.js REST API service exposing routes under `/api/v1`.
- **Frontend**: The React single-page application that consumes the Backend REST API.
- **Supabase**: The managed platform providing PostgreSQL, Auth, Row-Level Security, and Realtime.
- **Session**: An authenticated Supabase Auth session associated with one RESPONSIBLE_User.
- **Points_Ledger**: The append-only `points_transactions` table that is the single source of truth for points. Rows are TASK_COMPLETION, MANUAL_ADJUSTMENT, REVERSAL, or REDEMPTION. Point totals are always derived by summing ledger rows, never stored as a mutable balance.
- **Task_Completion**: A record that a specific Family_Member completed a specific Task, capturing both the authenticated actor (RESPONSIBLE_User) and the Family_Member who did the work.
- **Reversal**: A negative Points_Ledger entry that cancels a prior TASK_COMPLETION award without deleting the original row, preserving audit history.
- **Redemption**: A negative Points_Ledger entry recording that a Family_Member spent points on an Award.
- **Carry_Over**: An unfinished Task from a prior day or week reproduced for the current period, linked to its origin via `carried_from_task_id`.
- **Recurring_Generation**: The idempotent creation of Tasks for a week from active Task_Templates, keyed by `template_id` + `due_date`.
- **Wall_Mode**: A landscape-first, large-touch-target, reduced-motion display of the family board at the `/wall` route, authenticated as the RESPONSIBLE_User.
- **RLS**: Row-Level Security — PostgreSQL policies that restrict every row to the owning RESPONSIBLE_User's family.
- **IDOR**: Insecure Direct Object Reference — accessing another family's record by guessing or supplying its identifier.
- **Error_Contract**: The uniform JSON error shape `{ "error": { "code": string, "message": string } }` returned by all Backend error responses.
- **Service_Role_Key**: The Supabase privileged key used only by the Backend, never exposed to the Frontend.

## Requirements

### Requirement 1: Authentication and Responsible-User Bootstrap

**User Story:** As a RESPONSIBLE_User, I want to sign in with Google and have my family automatically created on first login, so that I can start managing tasks without a separate signup flow.

#### Acceptance Criteria

1. THE Backend SHALL accept only Supabase Auth sessions established through Google OAuth as valid authentication.
2. WHEN a request arrives without a valid Supabase Session, THE Backend SHALL respond with HTTP 401 and Error_Contract code `UNAUTHORIZED`.
3. WHEN a request arrives with an expired Supabase Session, THE Backend SHALL respond with HTTP 401 and Error_Contract code `UNAUTHORIZED`.
4. WHEN an authenticated RESPONSIBLE_User calls `GET /api/v1/me` and no Family exists for that RESPONSIBLE_User, THE Backend SHALL create exactly one Family record owned by that RESPONSIBLE_User and return the RESPONSIBLE_User profile together with the Family.
5. WHEN an authenticated RESPONSIBLE_User calls `GET /api/v1/me` and a Family already exists for that RESPONSIBLE_User, THE Backend SHALL return the existing Family without creating an additional Family.
6. THE Backend SHALL associate at most one Family with each RESPONSIBLE_User.
7. THE Backend SHALL derive the RESPONSIBLE_User identity from the Supabase Session and SHALL NOT accept a user identifier from the request body, query, or headers.
8. THE Frontend SHALL remove all email/password authentication user interface and routes (Register, ForgotPassword, ResetPassword) in accordance with DP-3.

### Requirement 2: Family Management

**User Story:** As a RESPONSIBLE_User, I want to view and update my family profile, so that the board reflects my household name, avatar, and my relationship to the family.

#### Acceptance Criteria

1. WHEN an authenticated RESPONSIBLE_User calls `GET /api/v1/family`, THE Backend SHALL return the Family owned by that RESPONSIBLE_User.
2. WHEN an authenticated RESPONSIBLE_User calls `PATCH /api/v1/family` with valid fields among `name`, `avatar_url`, `relationship`, and `responsible_name`, THE Backend SHALL update only the Family owned by that RESPONSIBLE_User and return the updated Family.
3. IF a `relationship` value outside {FATHER, MOTHER, GUARDIAN, OTHER} is submitted, THEN THE Backend SHALL respond with HTTP 422 and Error_Contract code `VALIDATION`.
4. THE Backend SHALL derive `family_id` from the Supabase Session and SHALL NOT accept a `family_id` from the request.

### Requirement 3: Member Management

**User Story:** As a RESPONSIBLE_User, I want to add, edit, and deactivate family members, so that I can assign tasks to the people in my household.

#### Acceptance Criteria

1. WHEN an authenticated RESPONSIBLE_User calls `GET /api/v1/family/members`, THE Backend SHALL return the Family_Member records belonging to that RESPONSIBLE_User's Family.
2. WHEN an authenticated RESPONSIBLE_User calls `POST /api/v1/family/members` with a valid `name` and a `member_type` in {PARENT, CHILD, DEPENDENT}, THE Backend SHALL create a Family_Member in that RESPONSIBLE_User's Family with `active` defaulting to true and return the created Family_Member.
3. WHEN an authenticated RESPONSIBLE_User calls `PATCH /api/v1/family/members/:id` for a Family_Member in that RESPONSIBLE_User's Family, THE Backend SHALL update the Family_Member and return the updated record.
4. WHEN an authenticated RESPONSIBLE_User calls `DELETE /api/v1/family/members/:id` for a Family_Member in that RESPONSIBLE_User's Family, THE Backend SHALL set that Family_Member's `active` field to false and SHALL retain the Family_Member record so historical Task_Completion and Points_Ledger references remain intact.
5. IF a `member_type` value outside {PARENT, CHILD, DEPENDENT} is submitted, THEN THE Backend SHALL respond with HTTP 422 and Error_Contract code `VALIDATION`.
6. IF an authenticated RESPONSIBLE_User references a `:id` that belongs to another Family, THEN THE Backend SHALL respond with HTTP 404 and Error_Contract code `NOT_FOUND`.

### Requirement 4: Task Creation and Editing

**User Story:** As a RESPONSIBLE_User, I want to create and edit tasks with a title, assignee, priority, points, and schedule, so that household work is clearly defined.

#### Acceptance Criteria

1. WHEN an authenticated RESPONSIBLE_User calls `POST /api/v1/family/tasks` with a valid `title`, THE Backend SHALL create a Task in that RESPONSIBLE_User's Family with `status` defaulting to TODO and `priority` defaulting to MEDIUM, and return the created Task.
2. THE Backend SHALL derive `family_id` and `created_by_user_id` from the Supabase Session and SHALL NOT accept either value from the request.
3. WHEN an authenticated RESPONSIBLE_User calls `PATCH /api/v1/tasks/:id` for a Task in that RESPONSIBLE_User's Family with valid fields, THE Backend SHALL update the Task and return the updated record.
4. IF a `status` value outside {BACKLOG, TODO, WORKING, DONE} is submitted, THEN THE Backend SHALL respond with HTTP 422 and Error_Contract code `VALIDATION`.
5. IF a `priority` value outside {LOW, MEDIUM, HIGH, URGENT} is submitted, THEN THE Backend SHALL respond with HTTP 422 and Error_Contract code `VALIDATION`.
6. IF a `points` value below 0 is submitted, THEN THE Backend SHALL respond with HTTP 422 and Error_Contract code `VALIDATION`.
7. IF an `assigned_member_id` is submitted that does not belong to the RESPONSIBLE_User's Family, THEN THE Backend SHALL respond with HTTP 422 and Error_Contract code `VALIDATION`.

### Requirement 5: Task Deletion

**User Story:** As a RESPONSIBLE_User, I want to delete a task, so that I can remove items that are no longer relevant.

#### Acceptance Criteria

1. WHEN an authenticated RESPONSIBLE_User calls `DELETE /api/v1/tasks/:id` for a Task in that RESPONSIBLE_User's Family, THE Backend SHALL delete the Task and respond with HTTP 204.
2. IF an authenticated RESPONSIBLE_User references a `:id` that belongs to another Family, THEN THE Backend SHALL respond with HTTP 404 and Error_Contract code `NOT_FOUND`.

### Requirement 6: Task Listing and Filtering

**User Story:** As a RESPONSIBLE_User, I want to list tasks filtered by date, week, status, member, and priority, so that I can view the relevant slice of work.

#### Acceptance Criteria

1. WHEN an authenticated RESPONSIBLE_User calls `GET /api/v1/family/tasks`, THE Backend SHALL return only Tasks belonging to that RESPONSIBLE_User's Family.
2. WHERE a `date` query parameter is provided, THE Backend SHALL return only Tasks whose `due_date` equals the provided date.
3. WHERE a `weekStart` query parameter is provided, THE Backend SHALL return only Tasks whose `week_start` equals the provided value.
4. WHERE a `status` query parameter is provided, THE Backend SHALL return only Tasks whose `status` equals the provided value.
5. WHERE a `memberId` query parameter is provided, THE Backend SHALL return only Tasks whose `assigned_member_id` equals the provided value.
6. WHERE a `priority` query parameter is provided, THE Backend SHALL return only Tasks whose `priority` equals the provided value.
7. IF a query parameter value fails validation, THEN THE Backend SHALL respond with HTTP 422 and Error_Contract code `VALIDATION`.

### Requirement 7: Task Status Movement

**User Story:** As a RESPONSIBLE_User, I want to move a task between board columns, so that I can track work progress across BACKLOG, TODO, WORKING, and DONE.

#### Acceptance Criteria

1. WHEN an authenticated RESPONSIBLE_User calls `POST /api/v1/tasks/:id/move` with a target `status` in {BACKLOG, TODO, WORKING} for a Task in that RESPONSIBLE_User's Family, THE Backend SHALL set the Task `status` to the target value and return the updated Task.
2. IF a `POST /api/v1/tasks/:id/move` request supplies a target `status` of DONE, THEN THE Backend SHALL respond with HTTP 422 and Error_Contract code `VALIDATION` directing the caller to use the completion endpoint.
3. IF the target `status` is outside {BACKLOG, TODO, WORKING, DONE}, THEN THE Backend SHALL respond with HTTP 422 and Error_Contract code `VALIDATION`.

### Requirement 8: Task Completion and Actor-versus-Member Distinction

**User Story:** As a RESPONSIBLE_User, I want to mark a task done on behalf of the member who did it, so that the system records both who authorized the completion and who performed the work.

#### Acceptance Criteria

1. WHEN an authenticated RESPONSIBLE_User calls `POST /api/v1/tasks/:id/complete` with a `completedByMemberId` that references an active Family_Member in that RESPONSIBLE_User's Family, for a Task in that RESPONSIBLE_User's Family whose `status` is not DONE, THE Backend SHALL create a Task_Completion, set the Task `status` to DONE, and award points through the Points_Ledger.
2. WHEN a completion request succeeds, THE Backend SHALL respond with HTTP 201 and a payload containing the Task `status` equal to DONE, the completion timestamp (`completedAt`), the `completion.completedByMemberId` equal to the supplied `completedByMemberId`, and `points.awarded` equal to the point amount recorded in the Points_Ledger for this completion.
3. THE Backend SHALL set the Task_Completion `completed_by_user_id` to the authenticated RESPONSIBLE_User identifier derived from the Supabase Session.
4. THE Backend SHALL set the Task_Completion `completed_by_member_id` to the `completedByMemberId` supplied in the request, crediting that Family_Member regardless of the Task's `assigned_member_id`.
5. IF `completedByMemberId` is missing or empty, THEN THE Backend SHALL respond with HTTP 422 and Error_Contract code `VALIDATION`.
6. IF `completedByMemberId` references a Family_Member whose `active` field is false, THEN THE Backend SHALL respond with HTTP 422 and Error_Contract code `VALIDATION` and SHALL NOT create a Task_Completion or a Points_Ledger entry.
7. IF `completedByMemberId` references a Family_Member that does not belong to the Task's Family, THEN THE Backend SHALL respond with HTTP 403 and Error_Contract code `FORBIDDEN`.
8. IF the referenced Task does not belong to the RESPONSIBLE_User's Family, THEN THE Backend SHALL respond with HTTP 404 and Error_Contract code `NOT_FOUND`.

### Requirement 9: Duplicate-Completion Prevention

**User Story:** As a RESPONSIBLE_User, I want the system to reject completing an already-completed task, so that points are never awarded twice for the same task.

#### Acceptance Criteria

1. THE Backend SHALL enforce a database uniqueness constraint on `task_id` in the Task_Completion table so that at most one Task_Completion exists per Task.
2. IF a `POST /api/v1/tasks/:id/complete` request targets a Task whose `status` is already DONE, THEN THE Backend SHALL respond with HTTP 409 and Error_Contract code `TASK_ALREADY_COMPLETED`.
3. IF a `POST /api/v1/tasks/:id/complete` request targets a Task that already has a Task_Completion, THEN THE Backend SHALL respond with HTTP 409 and Error_Contract code `TASK_ALREADY_COMPLETED` and SHALL NOT create an additional Points_Ledger entry.
4. WHEN two completion requests for the same Task are processed concurrently, THE Backend SHALL allow at most one Task_Completion and at most one TASK_COMPLETION Points_Ledger entry to be created.

### Requirement 10: Points Ledger and Atomic Awarding

**User Story:** As a RESPONSIBLE_User, I want points recorded in an append-only ledger that updates atomically with completion, so that totals are always consistent and auditable.

#### Acceptance Criteria

1. THE Backend SHALL treat the Points_Ledger as the single source of truth and SHALL compute every point total by summing Points_Ledger rows rather than reading a stored balance.
2. WHEN a Task with a `points` value greater than 0 is completed, THE Backend SHALL create one Points_Ledger entry with `transaction_type` TASK_COMPLETION, `member_id` equal to the completing Family_Member, `points` equal to the Task `points`, and `task_id` equal to the Task.
3. WHEN a Task with a `points` value of 0 is completed, THE Backend SHALL create the Task_Completion and set the Task to DONE without creating a Points_Ledger entry.
4. THE Backend SHALL perform the Task_Completion insert, the Points_Ledger insert, and the Task status update for a single completion as one atomic database transaction.
5. IF any step of the completion transaction fails, THEN THE Backend SHALL roll back all steps of that transaction so that no partial Task_Completion, Points_Ledger entry, or status change persists.
6. THE Backend SHALL derive `points` for a TASK_COMPLETION entry from the stored Task record and SHALL NOT accept a `points` value from the completion request.

### Requirement 11: Reopen and Reversal

**User Story:** As a RESPONSIBLE_User, I want to reopen a completed task and have its points reversed without losing history, so that mistakes can be corrected while the audit trail is preserved.

#### Acceptance Criteria

1. WHEN an authenticated RESPONSIBLE_User calls `POST /api/v1/tasks/:id/reopen` for a Task in that RESPONSIBLE_User's Family whose `status` is DONE, THE Backend SHALL remove the Task_Completion, create a Reversal Points_Ledger entry, set the Task `status` to TODO, and respond with HTTP 200 and a payload containing the updated Task and a non-negative `reversedPoints` field.
2. THE Backend SHALL create the Reversal entry with `transaction_type` REVERSAL, `points` equal to the negative of the original TASK_COMPLETION points, and `member_id` equal to the member on the removed Task_Completion.
3. THE Backend SHALL retain the original TASK_COMPLETION Points_Ledger entry when reopening a Task.
4. IF a `POST /api/v1/tasks/:id/reopen` request targets a Task whose `status` is not DONE, THEN THE Backend SHALL respond with HTTP 422 and Error_Contract code `VALIDATION`.
5. WHEN the original completion awarded 0 points, THE Backend SHALL reopen the Task and set `reversedPoints` to 0 without creating a REVERSAL entry.
6. THE Backend SHALL perform the Task_Completion removal, the Reversal insert, and the Task status update for a single reopen as one atomic database transaction, and IF any step fails THEN THE Backend SHALL roll back all steps so no partial change persists.
7. WHEN a Task has been reopened, THE Backend SHALL allow that Task to be completed again, producing a new Task_Completion and a new TASK_COMPLETION entry.
8. IF the referenced Task does not belong to the RESPONSIBLE_User's Family, THEN THE Backend SHALL respond with HTTP 404 and Error_Contract code `NOT_FOUND`.
9. WHEN two reopen requests for the same Task are processed concurrently, THE Backend SHALL remove at most one Task_Completion and create at most one REVERSAL entry.
10. WHEN reopening a Task reverses points such that the Family_Member's derived point total would become negative, THE Backend SHALL still create the Reversal entry and allow the derived total to go negative, preserving the append-only audit trail.

### Requirement 12: Recurring Task Templates

**User Story:** As a RESPONSIBLE_User, I want to define recurring task templates, so that routine chores can be generated automatically each week.

#### Acceptance Criteria

1. WHEN an authenticated RESPONSIBLE_User calls `GET /api/v1/family/task-templates`, THE Backend SHALL return the Task_Templates belonging to that RESPONSIBLE_User's Family.
2. WHEN an authenticated RESPONSIBLE_User calls `POST /api/v1/family/task-templates` with a valid `title` and a `recurrence_type` in {DAILY, WEEKDAYS, WEEKLY, CUSTOM}, THE Backend SHALL create a Task_Template in that RESPONSIBLE_User's Family with `active` defaulting to true and return the created record.
3. WHEN an authenticated RESPONSIBLE_User calls `PATCH /api/v1/task-templates/:id` for a Task_Template in that RESPONSIBLE_User's Family, THE Backend SHALL update the Task_Template and return the updated record.
4. WHEN an authenticated RESPONSIBLE_User calls `DELETE /api/v1/task-templates/:id` for a Task_Template in that RESPONSIBLE_User's Family, THE Backend SHALL remove or deactivate the Task_Template and respond with HTTP 204.
5. IF a Task_Template has `recurrence_type` CUSTOM, THEN THE Backend SHALL require `recurrence_config.days` to contain an array of integers in the range 0 through 6, and otherwise respond with HTTP 422 and Error_Contract code `VALIDATION`.

### Requirement 13: Idempotent Recurring Generation

**User Story:** As a RESPONSIBLE_User, I want recurring generation to be safe to run repeatedly, so that re-running it never produces duplicate tasks for the same week.

#### Acceptance Criteria

1. WHEN an authenticated RESPONSIBLE_User calls `POST /api/v1/family/task-templates/generate` with a `weekStart`, THE Backend SHALL create Tasks for the seven dates of that week according to each active Task_Template's recurrence rule and return a payload containing `weekStart` and `created`, where `created` is the integer count of Tasks created by that invocation.
2. THE Backend SHALL generate a Task for a DAILY Task_Template on all seven dates of the week.
3. THE Backend SHALL generate a Task for a WEEKDAYS Task_Template only on Monday through Friday of the week.
4. THE Backend SHALL generate a Task for a WEEKLY Task_Template only on Monday of the week.
5. THE Backend SHALL generate a Task for a CUSTOM Task_Template only on the dates whose weekday number appears in `recurrence_config.days`, where the weekday number ranges from 0 (Sunday) through 6 (Saturday).
6. THE Backend SHALL compute each date's weekday number in UTC so that the recurrence rule evaluation is independent of server or client local time.
7. WHEN a Task already exists for a given `template_id` and `due_date` within the target week, THE Backend SHALL skip creation for that `template_id` and `due_date` and SHALL NOT count it toward `created`.
8. WHEN recurring generation is run more than once for the same `weekStart`, THE Backend SHALL produce the same final set of Tasks as a single run, and SHALL return `created` equal to 0 on every run after the first when no Task_Template or Task has changed in the interim.
9. IF `weekStart` is missing, is not a valid ISO-8601 calendar date in `YYYY-MM-DD` format, or does not fall on a Monday, THEN THE Backend SHALL respond with HTTP 422 and Error_Contract code `VALIDATION` and SHALL NOT create any Task.

### Requirement 14: Carry-Over of Unfinished Tasks

**User Story:** As a RESPONSIBLE_User, I want unfinished tasks to carry over to the current period, so that incomplete work is not lost between days or weeks.

#### Acceptance Criteria

1. WHEN carry-over runs for a target period, THE Backend SHALL create a new Task for each eligible unfinished prior-period Task and set the new Task's `carried_from_task_id` to the origin Task identifier.
2. THE Backend SHALL set the carried-over Task's `family_id` and `created_by_user_id` from the origin Task's Family and the Supabase Session respectively.
3. WHEN a Task has already been carried over for the target period, THE Backend SHALL NOT create a second carry-over of the same origin Task for that period.
4. THE Frontend SHALL display a "Carried from" indicator on any Task whose `carried_from_task_id` is set.

### Requirement 15: Leaderboard

**User Story:** As a RESPONSIBLE_User, I want a leaderboard ranked by points for a chosen period, so that family members can see standings over time.

#### Acceptance Criteria

1. WHEN an authenticated RESPONSIBLE_User calls `GET /api/v1/family/leaderboard` with a `period` in {today, week, month, all}, THE Backend SHALL return each active Family_Member's total points and completed-task count summed from the Points_Ledger within that period.
2. THE Backend SHALL rank leaderboard entries in descending order of points, breaking ties by descending completed-task count.
3. THE Backend SHALL count a Family_Member's completed tasks as the number of TASK_COMPLETION entries with positive points for that Family_Member within the period.
4. WHERE `period` is `all`, THE Backend SHALL include every Points_Ledger entry regardless of date.
5. IF `period` is outside {today, week, month, all}, THEN THE Backend SHALL respond with HTTP 422 and Error_Contract code `VALIDATION`.

### Requirement 16: Dashboard Aggregate

**User Story:** As a RESPONSIBLE_User, I want a single aggregated dashboard payload for the wall, so that the display loads household status in one request.

#### Acceptance Criteria

1. WHEN an authenticated RESPONSIBLE_User calls `GET /api/v1/family/dashboard`, THE Backend SHALL return an aggregated payload containing the Family, its active Family_Members, the current day's Tasks, and current point totals per Family_Member derived from the Points_Ledger.
2. THE Backend SHALL include in the dashboard payload only data belonging to the RESPONSIBLE_User's Family.
3. THE Backend SHALL compute dashboard point totals by summing Points_Ledger rows.

### Requirement 17: Weekly Board

**User Story:** As a RESPONSIBLE_User, I want a board view for a selected week, so that I can see tasks organized by day and status.

#### Acceptance Criteria

1. WHEN an authenticated RESPONSIBLE_User calls `GET /api/v1/family/board` with a `weekStart`, THE Backend SHALL return the Tasks for that week in the RESPONSIBLE_User's Family organized for board rendering.
2. IF `weekStart` is missing or malformed, THEN THE Backend SHALL respond with HTTP 422 and Error_Contract code `VALIDATION`.
3. THE Backend SHALL include only Tasks belonging to the RESPONSIBLE_User's Family in the board payload.

### Requirement 18: Awards and Redemption

**User Story:** As a RESPONSIBLE_User, I want to define rewards and redeem them against a member's points, so that members can spend earned points (per DP-2).

#### Acceptance Criteria

1. WHEN an authenticated RESPONSIBLE_User calls `GET /api/v1/family/awards`, THE Backend SHALL return the Award records belonging to that RESPONSIBLE_User's Family.
2. WHEN an authenticated RESPONSIBLE_User calls `POST /api/v1/family/awards` with a `title` of 1 to 200 characters and a `points_cost` integer in the range 0 to 999999, THE Backend SHALL create an Award in that RESPONSIBLE_User's Family and return the created record.
3. WHEN an authenticated RESPONSIBLE_User calls `PATCH /api/v1/awards/:id` for an Award in that RESPONSIBLE_User's Family, THE Backend SHALL update the Award and return the updated record.
4. WHEN an authenticated RESPONSIBLE_User calls `DELETE /api/v1/awards/:id` for an Award in that RESPONSIBLE_User's Family, THE Backend SHALL set the Award `active` field to false and retain the record.
5. WHEN an authenticated RESPONSIBLE_User calls `POST /api/v1/awards/:id/redeem` with a `memberId` for a Family_Member in that RESPONSIBLE_User's Family, THE Backend SHALL create one Points_Ledger entry with `transaction_type` REDEMPTION, `member_id` equal to the Family_Member, and `points` equal to the negative of the stored Award `points_cost`.
6. THE Backend SHALL derive the Award `points_cost` for a REDEMPTION entry from the stored Award record and SHALL NOT accept a cost value from the redemption request.
7. IF a redemption would reduce the Family_Member's derived point total below 0, THEN THE Backend SHALL respond with HTTP 422 and Error_Contract code `INSUFFICIENT_POINTS` and SHALL NOT create a Points_Ledger entry.
8. IF `memberId` is missing on a redemption request, THEN THE Backend SHALL respond with HTTP 422 and Error_Contract code `VALIDATION`.
9. IF a redemption `memberId` references a Family_Member that does not belong to the Award's Family, THEN THE Backend SHALL respond with HTTP 403 and Error_Contract code `FORBIDDEN`.
10. IF a `PATCH`, `DELETE`, or redeem request references an Award `:id` belonging to another Family, THEN THE Backend SHALL respond with HTTP 404 and Error_Contract code `NOT_FOUND`.
11. THE Backend SHALL perform the balance check and the REDEMPTION Points_Ledger insert for a single redemption as one atomic database transaction, so that concurrent redemptions cannot drive the derived total below 0.
12. THE Backend SHALL extend the `points_transactions` `transaction_type` constraint to include REDEMPTION in addition to TASK_COMPLETION, MANUAL_ADJUSTMENT, and REVERSAL.

### Requirement 19: Wall Mode

**User Story:** As a RESPONSIBLE_User, I want a landscape wall display with large touch targets and reduced motion, so that the family board is readable and energy-efficient on a mounted screen.

#### Acceptance Criteria

1. WHEN the Frontend renders the `/wall` route, THE Frontend SHALL display the board optimized for a 1024×768 landscape viewport as the primary target.
2. THE Frontend SHALL render interactive controls in Wall_Mode with touch targets of at least 44 by 44 CSS pixels.
3. WHILE the device reports `prefers-reduced-motion`, THE Frontend SHALL suppress non-essential animation in Wall_Mode.
4. THE Frontend SHALL require an authenticated RESPONSIBLE_User Session to render Wall_Mode.
5. WHILE Wall_Mode is active, THE Frontend SHALL reflect realtime Task, Task_Completion, and Points_Ledger changes without a manual page reload.

### Requirement 20: Frontend Pages Parity

**User Story:** As a RESPONSIBLE_User, I want all existing pages to keep working after the migration, so that no functionality is lost (per DP-2).

#### Acceptance Criteria

1. THE Frontend SHALL retain functional Board, Wall, Members, MemberProfile, Leaderboard, Settings, TaskTemplates, FamilyAwards, PointsHistory, Home, and Onboarding pages backed by the Backend REST API.
2. WHEN a first-login RESPONSIBLE_User has no Family_Members, THE Frontend SHALL present the Onboarding flow to create the initial family profile and members.
3. WHEN the RESPONSIBLE_User opens the MemberProfile page for a Family_Member, THE Frontend SHALL display that Family_Member's completed Task_Completions and point history retrieved from the Backend.
4. WHEN the RESPONSIBLE_User opens the PointsHistory page, THE Frontend SHALL display Points_Ledger entries retrieved from the Backend.

### Requirement 21: Realtime Updates

**User Story:** As a RESPONSIBLE_User, I want the board to update automatically when data changes, so that multiple viewers stay in sync without refreshing.

#### Acceptance Criteria

1. WHEN a Task, Task_Completion, or Points_Ledger row changes in Supabase for the RESPONSIBLE_User's Family, THE Frontend SHALL receive a realtime notification and invalidate the corresponding TanStack Query caches.
2. THE Frontend SHALL subscribe only to realtime changes scoped to the authenticated RESPONSIBLE_User's Family.
3. IF the realtime connection is unavailable, THEN THE Frontend SHALL fall back to a low-frequency periodic refresh of the affected queries.

### Requirement 22: Optimistic Task Completion

**User Story:** As a RESPONSIBLE_User, I want task completion to feel instant with safe rollback on failure, so that the interface is responsive without showing incorrect point awards.

#### Acceptance Criteria

1. WHEN the RESPONSIBLE_User completes a Task, THE Frontend SHALL optimistically mark the Task as DONE in the interface before the Backend responds.
2. IF the completion request returns an error, THEN THE Frontend SHALL roll back the optimistic change and restore the Task to its prior state.
3. THE Frontend SHALL display awarded points only after the Backend confirms the completion.

### Requirement 23: Security, RLS, Authorization, and Input Validation

**User Story:** As a RESPONSIBLE_User, I want strict isolation and server-side validation, so that no one can read or modify another family's data or manipulate points.

#### Acceptance Criteria

1. THE Supabase database SHALL enforce RLS policies on every table so that a RESPONSIBLE_User can access only rows belonging to that RESPONSIBLE_User's Family.
2. THE Backend SHALL derive `family_id`, `created_by_user_id`, `completed_by_user_id`, `points`, and the RESPONSIBLE_User role from the Supabase Session and SHALL NOT trust any of these values from the client.
3. IF a request references a resource identifier belonging to another Family, THEN THE Backend SHALL respond with HTTP 404 and Error_Contract code `NOT_FOUND` and SHALL NOT disclose the existence of that resource.
4. THE Backend SHALL validate request body, query, and path parameters for every route using a schema validator and SHALL reject invalid input with HTTP 422 and Error_Contract code `VALIDATION`.
5. THE Backend SHALL use the Supabase Service_Role_Key only on the server and SHALL NOT expose the Service_Role_Key to the Frontend or in any client-reachable response.
6. IF a request attempts to set `points` or `member_id` on a Points_Ledger entry directly through a create or update endpoint, THEN THE Backend SHALL reject the request with HTTP 403 and Error_Contract code `FORBIDDEN`.

### Requirement 24: Frontend Data-Layer Migration off Base44

**User Story:** As a RESPONSIBLE_User, I want the frontend to run on the new REST API instead of Base44, so that the application no longer depends on the Base44 SDK (per DP-1).

#### Acceptance Criteria

1. THE Frontend SHALL replace all `base44.entities.*`, `base44.functions.invoke`, and `base44.auth` usage with calls to a typed REST client that targets the Backend `/api/v1` routes.
2. THE Frontend SHALL remove the `@base44/sdk` dependency and the `src/api/base44Client.js` module from the application code paths.
3. THE Frontend SHALL implement a REST client module (authored in TypeScript) plus per-domain API modules for family, members, tasks, templates, points, awards, and dashboard, wired through TanStack Query.
4. THE Frontend SHALL retain its existing `.jsx` page and component structure in accordance with DP-1, changing only the data-access layer and authentication wiring.
5. WHEN the RESPONSIBLE_User's Session expires during use, THE Frontend SHALL detect the resulting 401 response and redirect to the Google OAuth login flow.
6. THE Frontend SHALL read its configuration from `VITE_API_URL`, `VITE_SUPABASE_URL`, and `VITE_SUPABASE_ANON_KEY` environment variables.

### Requirement 25: Error Contract

**User Story:** As a Frontend developer, I want every backend error in a single predictable shape, so that error handling is uniform across the client.

#### Acceptance Criteria

1. WHEN the Backend returns any error response, THE Backend SHALL return a JSON body matching the Error_Contract shape `{ "error": { "code": string, "message": string } }`.
2. THE Backend SHALL map validation failures to HTTP 422 with code `VALIDATION`, missing authentication to HTTP 401 with code `UNAUTHORIZED`, cross-family or forbidden actions to HTTP 403 with code `FORBIDDEN`, missing or foreign resources to HTTP 404 with code `NOT_FOUND`, duplicate completion to HTTP 409 with code `TASK_ALREADY_COMPLETED`, and unexpected failures to HTTP 500 with code `INTERNAL`.
3. THE Backend SHALL NOT include stack traces, SQL text, or secret values in any Error_Contract `message`.

### Requirement 26: Observability, Logging, and Health

**User Story:** As an operator, I want structured logs and health endpoints, so that I can monitor and orchestrate the backend safely.

#### Acceptance Criteria

1. THE Backend SHALL emit structured logs for each request and error without including secrets, tokens, Service_Role_Key values, or full request bodies containing credentials.
2. WHEN `GET /api/v1/health` is called, THE Backend SHALL respond with HTTP 200 when the process is running.
3. WHEN `GET /api/v1/ready` is called and the Backend can reach Supabase, THE Backend SHALL respond with HTTP 200.
4. IF the Backend cannot reach Supabase when `GET /api/v1/ready` is called, THEN THE Backend SHALL respond with HTTP 503.

### Requirement 27: API Documentation

**User Story:** As a Frontend developer, I want browsable API docs, so that I can integrate against accurate endpoint and schema definitions.

#### Acceptance Criteria

1. THE Backend SHALL publish OpenAPI documentation at `/api/docs`.
2. THE Backend SHALL document every `/api/v1` route including its request parameters, request body schema, response schema, and Error_Contract responses in the OpenAPI documentation.

### Requirement 28: Database Migrations and Seed Data

**User Story:** As a developer, I want reproducible migrations and demo seed data, so that any environment can be rebuilt consistently.

#### Acceptance Criteria

1. THE Backend repository SHALL include reproducible SQL migrations that create the schema, indexes, RLS policies, the atomic completion function, and Realtime configuration for all tables.
2. THE migrations SHALL create a UNIQUE constraint on `task_id` in the Task_Completion table.
3. WHEN the migrations are applied to an empty database, THE resulting schema SHALL support every Backend route without manual schema edits.
4. THE Backend repository SHALL include seed data for a "Rodrigues Family" demo covering a Family, Family_Members, Task_Templates, and Tasks.
5. WHEN the seed script is run twice against the same database, THE seed script SHALL NOT create duplicate demo records.

### Requirement 29: Deployment, Docker, Environment, and CORS

**User Story:** As an operator, I want both services containerized with their own Docker configuration and orchestrated by a single Docker Compose file, so that the whole system can be deployed securely and independently with one command.

#### Acceptance Criteria

1. THE Backend repository SHALL include a multi-stage Dockerfile at `backend/Dockerfile` that builds the TypeScript backend and runs it as a non-root user.
2. THE Frontend repository SHALL include a multi-stage Dockerfile at `frontend/Dockerfile` that builds the Vite application and serves the static build artifacts, running as a non-root user.
3. THE repository SHALL include a root `docker-compose.yml` that defines a `backend` service built from `backend/Dockerfile` and a `frontend` service built from `frontend/Dockerfile`, with the `frontend` service depending on the `backend` service.
4. THE `docker-compose.yml` SHALL inject each service's configuration from environment variables or an env file and SHALL NOT hardcode the Supabase Service_Role_Key in the compose file or any image layer.
5. WHEN `docker compose up` is run with the required environment variables provided, THE system SHALL start both the Backend and Frontend services and expose each on its configured port.
6. THE Backend SHALL read configuration from `PORT`, `NODE_ENV`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, and `CORS_ORIGIN` environment variables.
7. THE Frontend SHALL read configuration from `VITE_API_URL`, `VITE_SUPABASE_URL`, and `VITE_SUPABASE_ANON_KEY` environment variables at build time.
8. WHILE `NODE_ENV` is `production`, THE Backend SHALL restrict CORS to the origins listed in `CORS_ORIGIN` and SHALL NOT allow a wildcard `*` origin.
9. IF a required environment variable is missing at startup, THEN THE Backend SHALL fail startup with a descriptive log message that does not print secret values.
10. THE Frontend and Backend SHALL each be independently deployable with their own build and configuration, and SHALL also be deployable together via the root `docker-compose.yml`.

### Requirement 30: Build, Test, and Definition of Done

**User Story:** As a developer, I want both apps to install, build, and test cleanly with meaningful coverage, so that the delivered system is verifiably complete.

#### Acceptance Criteria

1. WHEN `npm install && npm run build` is run in the Backend and in the Frontend, THE commands SHALL complete without errors, without unresolved imports, and without placeholder implementations.
2. WHEN `npm run test` is run in the Backend, THE Backend test suite SHALL cover task CRUD, task completion, duplicate-completion prevention, points awarding, reopen and reversal, carry-over, recurring generation, cross-family access denial, point-manipulation denial, and IDOR protection.
3. WHEN `npm run test` is run in the Frontend, THE Frontend test suite SHALL cover authenticated login state, dashboard rendering, task completion with error rollback, member management, board rendering, leaderboard rendering, and Wall_Mode.
4. WHEN the TypeScript typecheck script is run, THE check SHALL report no type errors.

### Requirement 31: Accessibility

**User Story:** As a user with accessibility needs, I want the interface to meet baseline accessibility practices, so that the board is usable with assistive technology and varied input.

#### Acceptance Criteria

1. THE Frontend SHALL provide keyboard navigation and a visible focus indicator for all interactive controls.
2. THE Frontend SHALL meet a text contrast ratio of at least 4.5 to 1 for normal-size text.
3. THE Frontend SHALL render touch targets of at least 44 by 44 CSS pixels for primary interactive controls.
4. WHILE the device reports `prefers-reduced-motion`, THE Frontend SHALL suppress non-essential animation across the application.
