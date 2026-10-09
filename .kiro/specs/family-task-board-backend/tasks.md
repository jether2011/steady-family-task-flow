# Implementation Plan: Family Task Board Backend + Frontend Migration

## Overview

This plan builds a Node.js + TypeScript + Fastify backend over Supabase (PostgreSQL + RLS + Realtime + Google OAuth) and migrates the existing `.jsx` frontend off the Base44 SDK onto a typed REST client — strictly as a data-layer swap. Work proceeds bottom-up and test-first: project scaffolding, then the reproducible SQL schema/migrations the whole API depends on, then the shared cross-cutting layer, then one vertical domain slice at a time (auth → family → members → tasks → completions/ledger → templates/recurring/carry-over → gamification → dashboard/board), each wired into the Fastify app as it lands so nothing is orphaned. Docs and health come next, then the full backend test suite including the 14 `fast-check` correctness properties and the security tests. The frontend is migrated incrementally (REST client → auth → hooks repoint → realtime → optimistic completion → Wall Mode → parity pages), followed by its test suite. The final task produces the deployment artifacts and runs the build + test Definition-of-Done gate for both apps.

The design uses specific languages (backend: TypeScript/Fastify; frontend: existing `.jsx` plus `.ts` client), so no implementation-language selection is required. The design includes a Correctness Properties section (14 properties), so property-based test sub-tasks are included and each references its property by number.

Backend atomic ledger operations go through plpgsql RPC functions (`complete_task`/`reopen_task`/`redeem_award`) invoked via the service-role client; reads and plain CRUD use the user-scoped client so RLS is a second isolation guarantee. Manual, human-only steps (provisioning the Supabase project, enabling the Google OAuth provider in the Supabase dashboard, deploying to a host) are out of scope and only noted inline where they are hard prerequisites — the config/migration/compose/docs *files* themselves are coding tasks and are included.

## Tasks

- [x] 1. Scaffold the backend project (Fastify + TypeScript, config, Supabase clients)
  - [x] 1.1 Create the backend package and TypeScript/tooling config
    - Add `backend/package.json` with Fastify, `@fastify/cors`, `@fastify/swagger`(+UI), `fastify-type-provider-zod`, `zod`, `pino`, `@supabase/supabase-js`, `jose` (JWT/JWKS), and dev deps Vitest, Supertest, `fast-check`, `typescript`, `tsx`; scripts `build` (`tsc`), `dev`, `start`, `test`, `typecheck`
    - Add `backend/tsconfig.json` with `strict: true`, `noUncheckedIndexedAccess`, ESM/`moduleResolution`, `outDir: dist`
    - Add `backend/vitest.config.ts` and the module directory skeleton (`src/config`, `src/middleware`, `src/modules/{auth,family,members,tasks,completions,gamification,dashboard}`, `src/shared/{errors,types,utils,constants}`, `src/supabase/migrations`, `tests/{unit,integration}`)
    - _Requirements: 29.1, 30.1, 30.4_
  - [x] 1.2 Implement env validation and the Supabase client factory
    - `src/config/env.ts`: parse `PORT, NODE_ENV, SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, CORS_ORIGIN` with Zod; fail-fast on a missing var with a message naming the key but never the value
    - `src/config/supabase.ts`: build a user-scoped client (anon key + forwarded user JWT) and a service-role client (service key, server-only)
    - _Requirements: 29.6, 29.9, 23.5_
  - [x] 1.3 Create the Fastify app and server skeleton
    - `src/app.ts`: Fastify instance with pino logging (redaction configured in task 3.3), zod type provider, CORS plugin wiring, route-registration stub, and a `setErrorHandler` placeholder
    - `src/server.ts`: `listen(PORT)` + graceful shutdown; call `env.ts` so startup fails fast on bad config
    - _Requirements: 29.5, 29.8, 30.1_
  - [x]* 1.4 Write a startup/env test
    - Assert missing required env throws a descriptive, secret-free error and exits non-zero; assert the app boots with valid env
    - _Requirements: 29.9_

- [x] 2. Author the reproducible SQL migrations and seed
  - [x] 2.1 Write `001_initial_schema.sql`
    - All tables (`responsible_users`, `families`, `family_members`, `task_templates`, `tasks`, `task_completions`, `points_transactions`, `awards`) with enums as `TEXT ... CHECK`, FKs, `points >= 0`, `points_cost >= 0`, `UNIQUE(task_id)` on `task_completions`, `UNIQUE(responsible_user_id)` on `families`, and the REDEMPTION value in the `transaction_type` CHECK
    - _Requirements: 28.2, 28.3, 9.1, 18.12, 1.6_
  - [x] 2.2 Write `002_indexes.sql`
    - Family-scoped indexes plus the partial `UNIQUE(template_id, due_date) WHERE template_id IS NOT NULL` idempotency backstop
    - _Requirements: 13.7, 13.8, 28.1_
  - [x] 2.3 Write `003_rls.sql`
    - `current_family_id()` helper; enable RLS on every table; owner-scoped SELECT/INSERT/UPDATE/DELETE policies; no user-role write policy on `task_completions`/`points_transactions` (ledger writes service-role only), reads family-scoped
    - _Requirements: 23.1, 23.6, 28.1_
  - [x] 2.4 Write `004_functions.sql` (atomic RPCs + trigger)
    - `complete_task`, `reopen_task`, `redeem_award` as `SECURITY DEFINER` plpgsql in one implicit transaction each, using `FOR UPDATE` locks, honoring `UNIQUE(task_id)`, raising named exceptions (`NOT_FOUND`, `TASK_ALREADY_COMPLETED`, `INSUFFICIENT_POINTS`); an `updated_at` trigger function applied to all tables with `updated_at`
    - _Requirements: 10.4, 10.5, 11.6, 18.11, 9.4, 11.9_
  - [x] 2.5 Write `005_realtime.sql`
    - Add `tasks`, `task_completions`, `points_transactions` to the `supabase_realtime` publication
    - _Requirements: 28.1_
  - [x] 2.6 Write idempotent `seed.sql` (Rodrigues Family demo)
    - Family, Family_Members, Task_Templates, Tasks via `insert ... on conflict do nothing` keyed on stable natural keys so a second run creates no duplicates
    - _Requirements: 28.4, 28.5_
  - [x]* 2.7 Write a migration + seed integration test
    - Apply all migrations to an empty DB and assert every table/constraint exists; run `seed.sql` twice and assert row counts are identical (idempotent)
    - _Requirements: 28.3, 28.5_

- [x] 3. Build the shared cross-cutting layer (errors, error handler, logging, schemas, types)
  - [x] 3.1 Implement shared error classes and DTO/row types
    - `src/shared/errors`: `AppError` + `Unauthorized`, `Forbidden`, `NotFound`, `ValidationError`, `Conflict` (`TASK_ALREADY_COMPLETED`), `InsufficientPoints`; `src/shared/types` DB row + DTO types; `src/shared/constants` enums/periods
    - _Requirements: 25.2_
  - [x] 3.2 Implement the error-handler middleware (Error_Contract)
    - `src/middleware/error-handler.ts`: map `AppError` subclasses and Zod errors to `{ "error": { "code", "message" } }` with the correct HTTP status; strip stack traces, SQL text, and secrets; wire into `app.ts` `setErrorHandler`
    - _Requirements: 25.1, 25.2, 25.3_
  - [x] 3.3 Configure pino structured logging with redaction
    - Redact `authorization`, `*.token`, `*.service_role*`, cookies, and credential-bearing bodies; one structured log line per request/error
    - _Requirements: 26.1_
  - [x]* 3.4 Write unit tests for the error contract and redaction
    - Every mapped error renders the Error_Contract with the right status and leaks no internals; logs omit redacted fields
    - _Requirements: 25.1, 25.2, 25.3, 26.1_
  - [x]* 3.5 Write the Error_Contract property test
    - **Property 12: Every error response matches the Error_Contract**
    - **Validates: Requirements 25.1, 25.2, 25.3**

- [x] 4. Implement authentication, context resolution, and the `/me` bootstrap
  - [x] 4.1 Implement JWT verification + context middleware
    - `src/middleware/authentication.ts`: verify the Bearer JWT against the Supabase JWKS, check expiry/issuer, trust only the signed `sub`; invalid/expired → `401 UNAUTHORIZED`
    - `src/middleware/context.ts`: resolve `responsible_users` by `auth_user_id` and `families` by `responsible_user_id`, attach `request.ctx = { userId, responsibleUserId, familyId }` (no family creation outside `/me`)
    - `src/middleware/authorization.ts`: by-id ownership guard helper (foreign/missing → `404 NOT_FOUND`)
    - _Requirements: 1.1, 1.2, 1.3, 1.7, 23.2, 23.3_
  - [x] 4.2 Implement the `/me` module with first-login family creation
    - `GET /api/v1/me`: create exactly one Family for the user if none exists (guarded by `UNIQUE(responsible_user_id)`), else return the existing one; return `{ family, responsibleUser }` with the composed family DTO; register routes/controller/service in `app.ts`
    - _Requirements: 1.4, 1.5, 1.6_
  - [x]* 4.3 Write auth + bootstrap tests
    - 401 on missing/expired token; `/me` creates family once then returns the same one; identity never read from body/query/headers
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.7_
  - [x]* 4.4 Write the bootstrap idempotency property test
    - **Property 1: Family bootstrap is idempotent**
    - **Validates: Requirements 1.4, 1.5, 1.6**

- [x] 5. Implement the Family and Members modules
  - [x] 5.1 Implement the family module (GET/PATCH with DTO split)
    - `GET /api/v1/family` returns the composed DTO; `PATCH /api/v1/family` validates with `FamilyUpdate` and routes `name`/`avatar_url` → `families` and `relationship`/`responsible_name`(→`name`) → `responsible_users` in one transaction; `family_id` always derived; invalid `relationship` → `422 VALIDATION`; register in `app.ts`
    - _Requirements: 2.1, 2.2, 2.3, 2.4_
  - [x] 5.2 Implement the members module (CRUD + soft delete)
    - `GET/POST /family/members`, `PATCH/DELETE /family/members/:id`; create defaults `active=true`; DELETE sets `active=false` and retains the row; invalid `member_type` → `422`; foreign `:id` → `404`; register in `app.ts`
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6_
  - [x]* 5.3 Write family + members tests
    - DTO round-trip for the field split; soft-delete retention keeps historical references intact; validation + foreign-id error codes
    - _Requirements: 2.2, 2.3, 3.4, 3.5, 3.6_

- [x] 6. Implement the Tasks module (CRUD, listing/filtering, move)
  - [x] 6.1 Implement task create/update/delete
    - `POST /family/tasks` (`status` default TODO, `priority` default MEDIUM, `family_id`/`created_by_user_id` derived), `PATCH /tasks/:id`, `DELETE /tasks/:id` → `204`; Zod `strict()` rejects client-supplied `status`/`family_id`; invalid `status`/`priority`/`points<0` → `422`; `assigned_member_id` not in family → `422`; foreign `:id` → `404`; register in `app.ts`
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 5.1, 5.2_
  - [x] 6.2 Implement task listing/filtering and move
    - `GET /family/tasks` with `date`/`weekStart`/`status`/`memberId`/`priority` filters, all family-scoped; `POST /tasks/:id/move` sets BACKLOG/TODO/WORKING and rejects DONE (→ `422` directing to the completion endpoint); invalid filter/status → `422`
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 7.1, 7.2, 7.3_
  - [x]* 6.3 Write task CRUD + move tests
    - CRUD happy paths; move→DONE rejection; each enum/points validation path; foreign-id 404
    - _Requirements: 4.4, 4.5, 4.6, 4.7, 5.2, 7.2, 7.3_
  - [x]* 6.4 Write the task-filtering property test
    - **Property 13: Task filtering returns exactly the matching, family-scoped subset**
    - **Validates: Requirements 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 17.1, 17.3**

- [x] 7. Implement completion, reopen, and the atomic points ledger
  - [x] 7.1 Implement task completion via `complete_task` RPC
    - `POST /tasks/:id/complete` with `completedByMemberId`: ownership check in code, then service-role RPC; set DONE, award points only when `points>0`, derive `points` from the stored task; respond `201` with `{ task:{status:DONE,completedAt}, completion:{completedByMemberId}, points:{awarded} }`; missing/empty/inactive member → `422`; member not in family → `403`; foreign task → `404`; already DONE/duplicate → `409 TASK_ALREADY_COMPLETED`; register in `app.ts`
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 8.8, 9.2, 9.3, 10.2, 10.3, 10.4, 10.5, 10.6, 23.6_
  - [x] 7.2 Implement reopen via `reopen_task` RPC
    - `POST /tasks/:id/reopen`: remove the Task_Completion, write a REVERSAL of `-original points` (none when 0), set status TODO, retain the original TASK_COMPLETION row, respond `200 { task, reversedPoints }`; non-DONE → `422`; foreign task → `404`; allow re-completion afterward; allow derived total to go negative
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 11.7, 11.8, 11.10_
  - [x]* 7.3 Write completion + reopen integration tests
    - Atomic award; 0-point completion creates no ledger row; duplicate → 409 with no extra ledger entry; reopen reversal + history retention; re-completion after reopen; actor-vs-member fields; inactive/foreign member and foreign task codes
    - _Requirements: 8.2, 8.6, 8.7, 9.2, 9.3, 10.3, 11.1, 11.3, 11.4, 11.7_
  - [x]* 7.4 Write the completion-award property test
    - **Property 2: Completion awards exactly the task's points, atomically, crediting the supplied member**
    - **Validates: Requirements 8.1, 8.2, 8.3, 8.4, 10.2, 10.3, 10.4, 10.5, 10.6**
  - [x]* 7.5 Write the at-most-one-completion property test
    - **Property 3: A task has at most one completion**
    - **Validates: Requirements 9.1, 9.2, 9.3, 9.4**
  - [x]* 7.6 Write the reopen-nets-to-zero property test
    - **Property 5: Complete-then-reopen nets to zero and preserves history**
    - **Validates: Requirements 11.1, 11.2, 11.3, 11.5, 11.6, 11.9, 11.10**
  - [x]* 7.7 Write the complete→reopen→complete property test
    - **Property 6: Complete → reopen → complete yields a single net positive award**
    - **Validates: Requirements 11.7**

- [x] 8. Checkpoint - core task + ledger slice
  - Ensure all tests pass, ask the user if questions arise.

- [x] 9. Implement task templates, recurring generation, and carry-over
  - [x] 9.1 Implement task-template CRUD
    - `GET/POST /family/task-templates`, `PATCH/DELETE /task-templates/:id` (DELETE deactivates → `204`); `recurrence_type` enum; CUSTOM requires `recurrence_config.days` of integers 0–6 else `422`; register in `app.ts`
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5_
  - [x] 9.2 Implement UTC date utilities and idempotent recurring generation
    - `src/shared/utils` UTC weekday + week-dates helpers; `POST /family/task-templates/generate` creates tasks per active template's rule (DAILY=7, WEEKDAYS=Mon–Fri, WEEKLY=Mon, CUSTOM=days), computed in UTC; skip existing `(template_id, due_date)` and don't count them; return `{ weekStart, created }`; missing/malformed/non-Monday `weekStart` → `422` with no tasks created
    - _Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 13.7, 13.8, 13.9_
  - [x] 9.3 Implement carry-over of unfinished tasks
    - `POST /family/tasks/carry-over`: for each eligible unfinished prior-period task create one new task with `carried_from_task_id` set and `family_id`/`created_by_user_id` derived; never carry the same origin twice for a target period
    - _Requirements: 14.1, 14.2, 14.3_
  - [x]* 9.4 Write the recurring-generation property test
    - **Property 7: Recurring generation is correct and idempotent**
    - **Validates: Requirements 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 13.7, 13.8**
  - [x]* 9.5 Write the carry-over property test
    - **Property 8: Carry-over is idempotent and linked**
    - **Validates: Requirements 14.1, 14.2, 14.3**
  - [x]* 9.6 Write the invalid-recurrence/weekStart property test
    - **Property 14: Invalid recurrence and weekStart inputs are rejected with no side effects**
    - **Validates: Requirements 12.5, 13.9**

- [x] 10. Implement the Gamification module (points, leaderboard, awards, redemption)
  - [x] 10.1 Implement ledger reads and leaderboard math
    - `GET /family/points` (with `memberId`/`from`/`to`), `GET /family/leaderboard` (`period` in today/week/month/all; totals + completed-task counts summed from the ledger; order by points desc then completedTasks desc; UTC period boundaries), `GET /family/members/:id/completions`; invalid `period` → `422`
    - _Requirements: 15.1, 15.2, 15.3, 15.4, 15.5, 10.1_
  - [x] 10.2 Implement awards CRUD and balance-guarded redemption
    - `GET/POST /family/awards` (title 1–200, `points_cost` 0–999999), `PATCH /awards/:id`, `DELETE /awards/:id` (active=false, retained); `POST /awards/:id/redeem` via `redeem_award` RPC: derive cost from the stored award, write one REDEMPTION of `-cost`, atomic balance check; insufficient balance → `422 INSUFFICIENT_POINTS` with no row; missing `memberId` → `422`; member not in award's family → `403`; foreign award `:id` → `404`; register in `app.ts`
    - _Requirements: 18.1, 18.2, 18.3, 18.4, 18.5, 18.6, 18.7, 18.8, 18.9, 18.10, 18.11_
  - [x]* 10.3 Write the ledger-sum property test
    - **Property 4: A member's displayed total equals the sum of their ledger rows**
    - **Validates: Requirements 10.1, 16.3**
  - [x]* 10.4 Write the leaderboard property test
    - **Property 9: Leaderboard math and ordering**
    - **Validates: Requirements 15.1, 15.2, 15.3, 15.4**
  - [x]* 10.5 Write the redemption property test
    - **Property 10: Redemption respects balance and records exactly the stored cost**
    - **Validates: Requirements 18.5, 18.6, 18.7, 18.11**

- [x] 11. Implement the Dashboard and Board aggregates
  - [x] 11.1 Implement dashboard and weekly board
    - `GET /family/dashboard` returns `{ family, members(active), todayTasks, totals }` with totals summed from the ledger, family-scoped only; `GET /family/board?weekStart` returns `{ weekStart, tasks, byDay, byStatus }` family-scoped; missing/malformed `weekStart` → `422`; register in `app.ts`
    - _Requirements: 16.1, 16.2, 16.3, 17.1, 17.2, 17.3_
  - [x]* 11.2 Write dashboard + board tests
    - Dashboard totals equal ledger sums and include only own-family data; board weekStart validation and family scoping
    - _Requirements: 16.2, 16.3, 17.2, 17.3_

- [x] 12. Add API documentation and health/readiness endpoints
  - [x] 12.1 Implement `/health`, `/ready`, and OpenAPI docs
    - `GET /api/v1/health` → 200 while up; `GET /api/v1/ready` → 200 when Supabase reachable else 503; `@fastify/swagger` UI at `/api/docs` documenting every `/api/v1` route (params, body, response, Error_Contract)
    - _Requirements: 26.2, 26.3, 26.4, 27.1, 27.2_
  - [x]* 12.2 Write health/ready + docs tests
    - `/health` 200; `/ready` returns 200/503 with Supabase mocked reachable/unreachable; `/api/docs` loads and lists routes
    - _Requirements: 26.2, 26.3, 26.4, 27.1_

- [x] 13. Implement the backend security test suite
  - [x]* 13.1 Write cross-family isolation and IDOR property test
    - **Property 11: Cross-family isolation and IDOR protection**
    - **Validates: Requirements 23.1, 23.2, 23.3, 23.6**
  - [x]* 13.2 Write point-manipulation and CORS/validation security tests
    - Client-supplied `points`/`member_id` on create/update → `403 FORBIDDEN`; cross-family by-id reads/mutations → `404` without disclosure; CORS refuses `*` in production
    - _Requirements: 23.2, 23.4, 23.6, 29.8_

- [x] 14. Checkpoint - backend complete
  - Ensure all backend tests pass and `tsc` is clean, ask the user if questions arise.

- [x] 15. Build the frontend REST client and per-domain API modules
  - [x] 15.1 Implement `src/api/client.ts` and `src/api/types.ts`
    - Fetch wrapper with base `VITE_API_URL + '/api/v1'`; attach `Authorization: Bearer <access_token>` from the Supabase session; parse Error_Contract into a typed `ApiError { code, message, status }`; serialize query params; on `401` trigger `redirectToLogin()`
    - _Requirements: 24.1, 24.3, 24.5, 24.6_
  - [x] 15.2 Implement per-domain API modules
    - `family.api.ts`, `members.api.ts`, `tasks.api.ts` (incl. `complete`, `reopen`, `move`, `carry-over`), `templates.api.ts` (incl. `generate`), `points.api.ts`, `awards.api.ts`, `dashboard.api.ts`, all typed and calling `client.ts`
    - _Requirements: 24.1, 24.3_
  - [x]* 15.3 Write client + api module tests
    - Bearer attachment, query serialization, Error_Contract → `ApiError`, 401 → redirect
    - _Requirements: 24.1, 24.5_

- [x] 16. Rework authentication to Supabase Google OAuth
  - [x] 16.1 Rewrite `src/lib/AuthContext.jsx` for Supabase OAuth
    - `signInWithOAuth({ provider: 'google' })`, `getSession()` + `onAuthStateChange`, `signOut()`, expose `getAccessToken()` and `redirectToLogin()`; `ProtectedRoute.jsx` reads `isAuthenticated` from the reworked context (requires the Google provider enabled in the Supabase dashboard — a manual prerequisite, not a code task)
    - _Requirements: 1.8, 24.5, 24.6_
  - [x] 16.2 Remove email/password + OAuthConsent pages and make Login a single Google screen
    - Delete `Register.jsx`, `ForgotPassword.jsx`, `ResetPassword.jsx`, `OAuthConsent.jsx` and their routes; `Login.jsx` becomes a "Continue with Google" screen
    - _Requirements: 1.8_
  - [x]* 16.3 Write authenticated login-state test
    - Login renders the Google button; authenticated session gates protected routes; removed pages/routes are gone
    - _Requirements: 1.8, 24.5, 30.3_

- [x] 17. Repoint `useFamily.js` hooks and remove the Base44 SDK
  - [x] 17.1 Repoint all hooks to the REST modules keeping identical query keys
    - `useFamily`/`useMembers`/`useTasks`/`usePoints`/`useTemplates`/`useCompletions`/`useAwards` and the `useCompleteTask`/`useReopenTask`/`useGenerateRecurring` mutations keep their exact TanStack Query keys and invalidation targets, now sourced from the api modules
    - _Requirements: 24.1, 24.3, 24.4_
  - [x] 17.2 Remove `@base44/sdk` and `base44Client.js`
    - Delete `src/api/base44Client.js` and remove the `@base44/sdk` (and `@base44/vite-plugin`) dependency and all import paths
    - _Requirements: 24.2, 24.4_
  - [x]* 17.3 Write hook-repoint + member-management tests
    - Hooks fetch via the api modules under unchanged keys; member add/edit/deactivate flows work end-to-end against mocked api modules
    - _Requirements: 24.1, 24.3, 30.3_

- [x] 18. Add realtime subscription with cache invalidation
  - [x] 18.1 Implement `useRealtime(familyId)`
    - Subscribe via `supabase.channel()` to `tasks`/`task_completions`/`points_transactions` changes filtered to `family_id=eq.<familyId>`; invalidate matching query keys on events; enable a low-frequency `refetchInterval` fallback when the channel is unhealthy
    - _Requirements: 21.1, 21.2, 21.3_
  - [x]* 18.2 Write realtime invalidation + fallback test
    - A simulated change invalidates the right keys; channel error enables the fallback refetch
    - _Requirements: 21.1, 21.3_

- [x] 19. Add optimistic task completion with rollback
  - [x] 19.1 Implement optimistic `useCompleteTask`
    - `onMutate` cancels `['tasks']`, snapshots cache, optimistically sets status DONE; `onError` restores the snapshot and toasts; awarded points shown only from the server `onSuccess`; `onSettled` invalidates `['tasks']` and `['points']`
    - _Requirements: 22.1, 22.2, 22.3_
  - [x]* 19.2 Write optimistic-completion + rollback test
    - Optimistic DONE appears before response; error rolls back to prior state; points render only after confirmation
    - _Requirements: 22.1, 22.2, 22.3, 30.3_

- [x] 20. Implement Wall Mode and accessibility
  - [x] 20.1 Implement the `/wall` route and apply accessibility across the app
    - Landscape board optimized for 1024×768, gated by `ProtectedRoute`, consuming realtime updates; `min-h-11 min-w-11` (≥44×44px) touch targets; `prefers-reduced-motion` suppresses non-essential animation in Wall Mode and app-wide; keyboard navigation with visible focus rings; text contrast ≥ 4.5:1
    - _Requirements: 19.1, 19.2, 19.3, 19.4, 19.5, 31.1, 31.2, 31.3, 31.4_
  - [x]* 20.2 Write Wall Mode test
    - Requires auth; landscape layout; reduced-motion suppresses animation; ≥44px targets; focus visible
    - _Requirements: 19.1, 19.2, 19.3, 19.4, 30.3_

- [x] 21. Wire carry-over indicator and parity pages
  - [x] 21.1 Add the "Carried from" indicator and wire parity pages to the REST API
    - Show a "Carried from" indicator on any task whose `carried_from_task_id` is set; wire MemberProfile (completions + point history), PointsHistory (ledger entries), Onboarding (first-login profile + members), and FamilyAwards to the api modules
    - _Requirements: 14.4, 20.1, 20.2, 20.3, 20.4_
  - [x]* 21.2 Write parity + board/leaderboard rendering tests
    - Carry-over indicator renders; MemberProfile/PointsHistory show backend data; Onboarding appears for a first-login user with no members; board and leaderboard render from api data
    - _Requirements: 14.4, 20.2, 20.3, 20.4, 30.3_

- [x] 22. Produce deployment artifacts and run the Definition-of-Done gate
  - [x] 22.1 Author Docker and env artifacts
    - `backend/Dockerfile` (multi-stage, non-root, `tsc` build) with `backend/.env.example`; `frontend/Dockerfile` (multi-stage Vite build → nginx non-root) with `frontend/nginx.conf` SPA fallback and `frontend/.env.example`; root `docker-compose.yml` with `backend` + `frontend` services, `frontend` depending on `backend`, config injected from env (service-role key never hardcoded)
    - _Requirements: 29.1, 29.2, 29.3, 29.4, 29.5, 29.7, 29.10_
  - [x] 22.2 Run the full build + test DoD gate for both apps
    - Run `npm install && npm run build`, `npm run test`, and the `tsc` typecheck in both `backend/` and `frontend/`; fix any failure, unresolved import, or placeholder so both apps build and all suites (including the 14 property tests) pass clean
    - _Requirements: 30.1, 30.2, 30.3, 30.4_

- [x] 23. Final checkpoint - full system green
  - Ensure all backend and frontend tests pass, both builds are clean, and `tsc` reports no errors; ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional (tests) and can be skipped for a faster MVP, but each property test is the only validation of its correctness property and the security tests back R23/R30.2.
- Every leaf task references the specific requirement sub-clauses it implements for traceability.
- Each of the 14 correctness properties is its own sub-task, placed adjacent to the implementation it checks, and annotated with its property number and the requirement clauses it validates.
- Atomic ledger work (complete/reopen/redeem) is exercised against the real schema so `UNIQUE(task_id)` and `FOR UPDATE` locks are tested under concurrency.
- Manual, human-only steps (Supabase project provisioning, enabling the Google OAuth provider, host deployment) are out of scope; only the corresponding config/migration/compose/docs files are produced here.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.3", "2.1", "15.1"] },
    { "id": 2, "tasks": ["1.4", "2.2", "2.3", "3.1", "3.3", "15.2"] },
    { "id": 3, "tasks": ["2.4", "2.5", "2.6", "3.2", "15.3", "16.1"] },
    { "id": 4, "tasks": ["2.7", "3.4", "3.5", "4.1", "16.2", "16.3"] },
    { "id": 5, "tasks": ["4.2", "4.3", "17.1", "17.2"] },
    { "id": 6, "tasks": ["4.4", "5.1", "5.2", "17.3", "18.1"] },
    { "id": 7, "tasks": ["5.3", "6.1", "18.2", "19.1"] },
    { "id": 8, "tasks": ["6.2", "6.3", "6.4", "19.2", "20.1"] },
    { "id": 9, "tasks": ["7.1", "20.2", "21.1"] },
    { "id": 10, "tasks": ["7.2", "7.3", "21.2"] },
    { "id": 11, "tasks": ["7.4", "7.5", "7.6", "7.7"] },
    { "id": 12, "tasks": ["9.1", "9.2", "9.3"] },
    { "id": 13, "tasks": ["9.4", "9.5", "9.6", "10.1", "10.2"] },
    { "id": 14, "tasks": ["10.3", "10.4", "10.5", "11.1"] },
    { "id": 15, "tasks": ["11.2", "12.1"] },
    { "id": 16, "tasks": ["12.2", "13.1", "13.2"] },
    { "id": 17, "tasks": ["22.1"] },
    { "id": 18, "tasks": ["22.2"] }
  ]
}
```
