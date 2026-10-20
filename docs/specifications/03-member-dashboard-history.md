# Specification 3: Member dashboard and history

Date: 2026-10-11 · Status: Implemented and merged; provider/policy rollout remains gated · Branch: `codex/member-dashboard-history`

Depends on [roles](01-tenant-membership-roles.md) and [email login](02-email-otp-login.md). Source: [PRD](../product/PRD-family-access-and-saas.md); [shared conventions](README.md).

## Outcome and boundaries

Give a MEMBER their family dashboard, assigned tasks, personal points/completion history, shared board, aggregate leaderboard and awards catalog. Preserve management experience for OWNER/MANAGER. Ordinary members have no product mutation controls or endpoints. Billing restrictions later compose with this capability model.

No new scoring policy, task completion permission, award spending permission or private family task feature. Managers must understand that task titles/descriptions and display rankings are shared with their family.

## API and DTO contracts

All routes are family-scoped through resolved context. UUID filters are validated; unknown query/body keys rejected. Safe directory fields are `{ id, name, avatar_url, color, member_type, active }`; omit birth year, email, auth IDs, access state and audit data. Existing full management DTOs remain available only to management roles.

| Method/path | MEMBER result | OWNER/MANAGER result |
| --- | --- | --- |
| GET `/family/member-dashboard` | `{family:{id,name,avatar_url}, member:SelfMemberDTO, balance, todayTasks, upcomingTasks, recentTransactions, recentCompletions, asOf}`; member derives solely from context | May use their participant if bound; owner without participant receives 403; management Home uses existing endpoint |
| GET `/family/member-directory` | `{members: SafeDirectoryMember[]}` for active roster; own inactive historical profile unavailable if login revoked | Same public directory |
| GET `/family/dashboard` | 403; do not return family-wide ledger or management payload | Existing aggregate management shape, canonical actors excluded unless necessary |
| GET `/family/board?weekStart=` and `/family/tasks` | Shared task DTOs with title, description, assignment, status, priority, points, due fields and family-local task ID; omit internal creator app-user IDs | Existing management task shape |
| GET `/family/points?memberId=&from=&to=&limit=&cursor=` | Default to self; another member ID → 404. Return own transactions and paginated metadata | Whole family or authorized member filter |
| GET `/family/members/:id/completions?limit=&cursor=` | Own completion history only; other ID → 404 | Authorized family member |
| GET `/family/members/:id/profile` | Own safe full participant profile and balance; another ID → 404 | Authorized participant profile |
| GET `/family/leaderboard?period=` | Authorized aggregate entries only | Same server aggregation |
| GET `/family/awards` | Public catalog: id/title/description/cost/icon/color/active | Catalog plus authorized management fields |

`SelfMemberDTO` includes participant's name/avatar/color/type/birth_year, never other members' private fields. Do not include membership email in board or self history. The read-only member profile has no edit form. Existing member-profile query parameter URLs are translated to the profile API only after context authorization.

Dashboard: balance sums all own ledger transactions; today tasks use existing server UTC date contract; upcoming list includes at most ten non-DONE assigned tasks with due date after today, ordered due date/time then ID. Recent transactions/completions return ten each in descending timestamp/ID order. Render completed tasks with zero awarded points correctly, independently of ledger rows. `asOf` is response snapshot time. Compute the dashboard consistently in a single database snapshot; do not mix totals from independently cached ledger requests.

Pagination: default 50, maximum 100. Opaque cursor encodes last timestamp/ID and filter/scope fingerprint; reject invalid or mismatched filters with 422. Sort transactions by `created_at DESC,id DESC`, completions by `completed_at DESC,id DESC`. Return `{transactions,nextCursor}` or `{completions,transactions,nextCursor}` preserving existing envelopes where applicable; combined completion response transactions relate to the returned completion page, while complete ledger history is fetched separately. Existing management callers without cursor receive first page and are updated to load further pages. No total omission is disguised as “complete history.” Add indexes `(family_id,member_id,created_at DESC,id DESC)` and analogous completion indexes. API summary endpoints compute over the selected full time range, not just visible page rows.

Add GET `/family/points/summary?memberId=&from=&to=` returning `{earned, adjustments, reversed, spent, net, balance}`. Self forcing applies. `earned` sums positive TASK_COMPLETION; `adjustments` sums MANUAL_ADJUSTMENT signed; `reversed` is absolute REVERSAL sum; `spent` absolute REDEMPTION sum; `net` is signed sum within filter; `balance` all-time signed sum. Zero-point completions contribute to completion history but not ledger-earned amount. Preserve legitimate negative balances after reversal.

## Leaderboard contract and date behavior

Reuse `leaderboard.service.ts` rather than `usePoints()` and client `computeLeaderboard`. The backend privately reads the authorized family ledger and returns `{entries:[{memberId,name,avatarUrl,color,points,completedTasks,rank}], period, from, asOf}`. No ledger rows, email, birth year or membership metadata leave the aggregate API.

Preserve current backend scoring: signed sum of every transaction type; completion count is number of positive TASK_COMPLETION ledger rows, not current DONE tasks. Zero-point completions do not count; historical completed awards later reversed retain the existing completion-count convention. UI must label this accurately rather than imply live completed-task count.

Preserve current backend boundaries: UTC midnight for today, midnight six days earlier for rolling seven-day week, existing `setUTCMonth(-1)` behavior for month including month-end rollover, no lower bound for all time. Labels become Today (UTC), Last 7 days, Monthly window (UTC), All time with a tooltip explaining the existing month boundary. A calendar-month or family-timezone redesign needs separate product approval. Sort points descending then completion count descending; stabilize display ties by member ID without changing scoring. Equal two-score tuples share competition rank (1,1,3). Return `from` so the UI can show the exact range; add snapshot `asOf` upper bound to avoid future-dated transactions. Use consistent calculation for all roles.

Fix points history date rendering to use `created_at`, not legacy `created_date`. API timestamps are authoritative. Keep weekly board Monday validation and existing recurrence semantics separate from rolling leaderboard periods.

## Frontend architecture and states

Refactor `Layout` navigation using server capabilities and trusted role; route guards verify permitted destinations before page data loads. Role is not selected in UI or read from provider metadata.

| MEMBER route | Experience |
| --- | --- |
| `/` | Personal summary, today's tasks, current balance, recent activity and shortcuts |
| `/board` | Shared weekly board, filters and task details; no drag handles/mutation menus |
| `/points-history` | My history, earned/spent/reversed/adjustment filters, date range, page loading and full-filter summaries |
| `/member-profile` | Own profile/work history; sanitized URL parameters cannot select someone else's private profile |
| `/leaderboard` | Server aggregate ranking/charts, self highlight, period selector, range explanation |
| `/family-awards` | Catalog with costs and own balance; no management/redeem controls |
| `/wall` | Existing large display layout; all mutation controls suppressed for MEMBER |

Denied paths `/members`, `/settings`, `/task-templates`, owner onboarding and billing do not mount management page hooks. Show a safe forbidden page with Home action. Manager and owner navigation remains intact, with billing added for owner by specification 5.

Each screen has loading, empty, partial network failure and retry states. A missing self binding is an access resolution failure, not a user-selectable profile. Restricted paid state in specification 6 displays an access banner and composes read-only capabilities without losing member navigation.

Cache scope: `['scope', appUserId, familyId, role, accessVersion, ...domainKey]`. Cancel/remove all prior scoped queries before changing identity/context. Realtime invalidation targets only current scoped keys; reject old in-flight generation results. Do not leave unscoped legacy `['points']` manager data reachable to member pages. Never persist protected query cache to browser storage.

Use specification 1's safe authenticated polling baseline for members: `/me` and visible-page queries every 30 seconds, refresh on focus, stop when logged out or revoked. Backend authorization on every poll is authoritative; poll interval does not authorize continued access. If manager realtime remains enabled, invalidate dashboard, tasks, points, history, leaderboard and catalog appropriately while respecting RLS. On membership/version change, cancel and clear before rendering. No family-wide raw ledger event feed for members.

## Implementation tasks

1. Add safe directory/personal dashboard/profile/summary schemas, repositories and services; extend paginated history and leaderboard response contracts.
2. Apply role/self filters on all reads plus database policies from specification 1; update OpenAPI and typed frontend APIs.
3. Add role navigation/guards and scoped query helpers; migrate every existing query/invalidation, including optimistic mutations used by managers.
4. Refactor Home, Board, TaskCard, MemberProfile, PointsHistory, Leaderboard, FamilyAwards and Wall to capability-aware controls and authorized DTOs.
5. Remove client family-ledger aggregation from leaderboard; fix timestamp labels, transaction categories and range labels.
6. Add indexes only through new migrations and retain all underlying ledger/member IDs.

## Test and acceptance

- Role-route API matrix and direct Supabase self-history checks for two families, owner, second manager, two members and a no-login participant.
- Manipulated `memberId`, profile URL and history cursor cannot return other members' data. Directory/leaderboard JSON must exclude private fields; server aggregation must not depend on public raw ledger grants.
- Ledger fixtures for completion/reversal/redemption/manual adjustment/zero points/negative balance; summary arithmetic uses complete filter range and balance remains all-time.
- Fixed-clock leaderboard tests for UTC boundaries, month-end rollover, ties, inactive participants and all-time rows older than twenty years.
- Pagination with identical timestamps, concurrent new rows and filter mismatch; no duplicated/omitted rows under the defined descending traversal.
- React tests for hidden/disabled mutations, unauthorized deep links, keyboard/mobile use, manager parity and view-only Wall.
- Account change, manager demotion, revoked membership, slow prior requests and polling errors cannot flash old private data.
- Real database suites validate policies and service-role filters; existing ledger/recurrence tests remain green.

## Release, observability and completion

Ship `MEMBER_VIEWS_ENABLED` only after personal/aggregate API and role guard deployment. When disabled, members see an explicit unavailable/access-safe screen; never fall back to manager Home. Rollback can disable member pages without expanding any permissions. No destructive migration.

Monitor personal dashboard latency, history errors, aggregate computation time, safe-directory size and cache/context transition failures. Proposed dashboard p95 target 3 seconds includes auth resolution; profile/history pages must load first page rather than full ledger. Completion requires both project tests/typechecks/builds, policy acceptance, management regression coverage and reviewed view/date policies.

Traceability: VIEW-01–08, AUTH-09, TEN-03/04, MEM-04/05. Server role foundation remains the authorization authority.
