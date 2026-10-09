-- 002_indexes.sql
-- Family Task Board — indexes (Supabase Postgres).
--
-- Every row-returning table is scanned by family (the primary tenancy boundary),
-- so each gets a family_id-leading index. Partial indexes on `active` keep the
-- hot "live rows only" lookups small for templates and awards. Composite indexes
-- on `tasks` match the board/list filter shapes (by week, due date, status,
-- assignee). The partial UNIQUE on tasks(template_id, due_date) is the
-- database-level idempotency backstop for recurring generation.
--
-- Indexes are given explicit names (idx_<table>_<cols>) rather than relying on
-- Postgres auto-naming, for clarity and reproducible migrations.
--
-- Requirements: R13.7 / R13.8 (recurring idempotency backstop), R28.1 (indexes).

-- family_members: list members of a family
create index idx_family_members_family on family_members(family_id);

-- task_templates: list active templates of a family (partial — only live rows)
create index idx_task_templates_family_active on task_templates(family_id) where active;

-- tasks: board & list query shapes, all family-scoped
create index idx_tasks_family_week on tasks(family_id, week_start);
create index idx_tasks_family_due on tasks(family_id, due_date);
create index idx_tasks_family_status on tasks(family_id, status);
create index idx_tasks_family_member on tasks(family_id, assigned_member_id);

-- tasks: recurring idempotency backstop (R13.7 / R13.8).
-- One generated task per (template, due_date); NULL template_id rows (ad-hoc
-- tasks) are excluded so they are never constrained.
create unique index idx_tasks_template_due_unique
  on tasks(template_id, due_date) where template_id is not null;

-- task_completions: family-scoped reads (dashboard, member profile)
create index idx_task_completions_family on task_completions(family_id);

-- points_transactions: ledger reads by member and by time, family-scoped
create index idx_points_tx_family_member on points_transactions(family_id, member_id);
create index idx_points_tx_family_created on points_transactions(family_id, created_at);

-- awards: list active awards of a family (partial — only live rows)
create index idx_awards_family_active on awards(family_id) where active;
