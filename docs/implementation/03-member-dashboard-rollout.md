# Specification 03: member dashboard and history

Branch: `codex/member-dashboard-history`, based on specifications 01 and 02. This release adds member views; it does not change task completion permissions, scoring policy, subscriptions, or tenant creation.

## Behavior and privacy

Members get a personal dashboard, shared weekly board and task details, their own profile/work history, paginated points history, server rankings, awards catalog and a read-only version of the large Wall display. Navigation omits member management, settings and templates. Denied deep links render a forbidden page before management hooks mount. A missing participant binding is an access error, never a selectable profile. OWNER/MANAGER retain management controls and can inspect authorized participant profiles/history.

The new authenticated APIs are `/family/member-dashboard`, `/family/member-directory`, `/family/members/:id/profile` and `/family/points/summary`. Existing points/completion history endpoints now return `nextCursor`; leaderboard returns ranked entries plus `period`, `from` and `asOf`. Request schemas reject unknown filters. Members' history/profile filters derive from the resolved binding; selecting someone else returns 404. Safe directory, catalog, task and aggregate JSON omit private participant and internal actor fields.

Migration 008 adds a backend-only stable read function. It re-resolves active membership from the verified provider subject and derives household scope inside the database. Each function call reads one PostgreSQL snapshot. Browser roles cannot invoke it; existing self-history RLS remains in force. The personal dashboard computes balance, assigned tasks and recent activity together. Zero-point completions appear without a ledger row; completion award projections exclude credits from earlier reversed completion cycles. No existing IDs or ledger rows are rewritten.

History uses descending `(timestamp,id)` traversal with default 50 and maximum 100. Signed opaque cursors bind to app user, family, role, access version, resource and filters. Changing filters/scope invalidates the cursor with 422. HMAC keys derive from the backend-only Supabase secret with domain separation; rotating that secret invalidates old cursors. Newer inserts appear after refreshing the first page; they do not move into the older continuation traversal. Concurrent deletes follow the existing completion/reopen lifecycle.

Summaries aggregate the entire selected UTC date/member range; balance remains all-time. Activity category filters apply to history rows; summary tiles explicitly include all categories for that date/member range. The UI shows loaded record counts and a Load more action, never labels an incomplete first page as complete history. Legacy management balance consumers collect all points pages to preserve their existing totals; profile/history screens load only the first page initially.

Leaderboard reads aggregate privately in SQL, then the existing leaderboard service supplies stable two-score ordering and competition ranks. Net points include every transaction category. Positive TASK_COMPLETION rows determine the displayed award count; zero-point work does not count, and later reversal does not erase the original count. Equal score tuples share rank (1,1,3), with ID stabilizing display order. UTC today/rolling seven-day/month-rollover/all-time rules are preserved, and `asOf` excludes future rows. Monthly labels explain the existing `setUTCMonth(-1)` behavior. Weekly board requests require Monday.

Every query/optimistic update/invalidation uses `['scope',appUserId,familyId,role,accessVersion,...domain]`. Scope transitions cancel and clear prior queries through AuthContext. Late mutation rollback cannot recreate a removed old cache. Polling and focus invalidation target only the current scope; protected data is never persisted to browser storage. Member components never mount management mutation hooks or use a family-wide raw points feed for ranking.

## Deployment order

1. Complete specification 01 membership provisioning/claims and specification 02 provider configuration first. New email claims require `MEMBERSHIP_ACCESS_ENABLED=true`; already-bound memberships retain access if provisioning is later disabled. Back up the database and record household/member/task/completion/ledger counts and ledger sums. Rehearse against a staging copy with two families, an Owner, another Manager, two Members and a participant without login.
2. Apply migrations 001–007 as required, then apply `008_member_views.sql` once using the migration ledger. It adds three indexes and one read function; it contains no destructive data mutation.
3. Deploy the compatible backend and frontend together. The new history/leaderboard contracts require both projects; legacy browser bundles must be refreshed. Backend `MEMBER_VIEWS_ENABLED` defaults to false and is passed through Docker Compose. This flag controls `/me`'s `member:views` capability. Keep it false until acceptance; disabled members see an explicit unavailable screen, never manager Home.
4. Verify the new API contracts and existing Owner/Manager workflows before enabling the flag. Confirm counts/sums and existing identities are unchanged, and rehearse rollback.
5. Set `MEMBER_VIEWS_ENABLED=true` on the backend and restart it. `/me` polling/focus refresh propagates the capability to connected sessions. No frontend build-time switch or new credential is needed.
6. Test actual Google/OTP Owner, Manager and Member sessions in staging, including revocation, role/version change and the specification 02 provider setup. Do not send invitations to real users for testing.

Rollback: disable the member-view flag, retain guards/schema/history and deploy a compatible forward fix. Do not restore an old binary that assumes every session owns a family or consumes unpaginated history.

## Acceptance and operational checks

- A member dashboard/profile can show only the bound participant's private fields. Shared directory/board/ranking/catalog contain public fields only. Manipulated member IDs, foreign families, forged cursors and stale access versions fail closed.
- Summary arithmetic covers completion, manual adjustment, reversal and redemption, including negative balances. Work history contains zero-point completions and does not double-count a prior reversed award.
- Pagination traverses equal timestamps without duplicates, and filters/cursors cannot cross scope. Leaderboard includes ancient all-time data, excludes future rows and inactive participants, and shares competition ranks correctly.
- Owner/Manager create/edit/complete/reopen/generate and optimistic rollback remain functional. Member board, Wall and catalog have no mutation controls. Keyboard task details, mobile navigation, empty/error/retry states and history paging remain usable.
- Watch existing backend request durations/error codes for personal dashboard/history/ranking endpoints; target dashboard p95 under three seconds including auth. Monitor repeated 422 cursor failures and context transition errors without logging mailbox addresses or tokens.

Local tests use a disposable PostgreSQL auth shim and mocked identity/provider sessions. Migration 008 has not been applied to hosted Supabase, and member-view access has not been enabled on the configured project. Hosted session smoke tests and performance measurements remain release checks.

## Local validation results

- Backend: 282 tests passed across 36 suites with disposable PostgreSQL, including all eight migrations, seed idempotency, role/RLS checks, snapshot reads, signed cursors, tied timestamps, UTC dates, repeat-award history, rankings and existing ledger/recurrence regressions.
- Frontend: 145 tests passed across 16 suites, including member-only reads, blocked management links, own-profile URL enforcement, zero-point work, full-range summaries, paging controls, scope changes and stale optimistic rollback.
- Backend/frontend typechecks and production builds passed. Changed UI files pass ESLint; repository-wide lint still reports three existing unused imports in untouched files.
- Hosted migration, real provider sessions, performance measurements and member-view enablement remain staging/release checks.
