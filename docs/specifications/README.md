# Family access and SaaS specifications

Date: 2026-10-11 · Status: Implementation design drafts

These six separate specifications implement section 13 of the [PRD](../product/PRD-family-access-and-saas.md). They define a coherent proposed implementation; writing them does not approve unresolved product policies or create implementation branches.

| Order | Specification | Planned branch | Depends on |
| --- | --- | --- | --- |
| 1 | [Tenant membership and roles](01-tenant-membership-roles.md) | `codex/tenant-membership-roles` | Current applications |
| 2 | [Email OTP login](02-email-otp-login.md) | `codex/email-otp-login` | 1 |
| 3 | [Member dashboard and history](03-member-dashboard-history.md) | `codex/member-dashboard-history` | 1, 2 |
| 4 | [SaaS tenant onboarding](04-saas-tenant-onboarding.md) | `codex/saas-tenant-onboarding` | 1 |
| 5 | [Stripe subscriptions](05-stripe-subscriptions.md) | `codex/stripe-subscriptions` | 1, 4; approved commercial configuration |
| 6 | [Subscription entitlements and rollout](06-subscription-entitlements.md) | `codex/subscription-entitlements` | 1–5; approved lifecycle/legacy policy |

## Shared conventions

- Family ID is the tenant ID. One authentication account has at most one reserved membership, including revoked access; moving to another family requires a future transfer workflow.
- Owner, Manager and Member are authorization roles, independent of family member type. Proposed Member access is read-only. Owner alone manages billing. Managers may appoint managers but cannot change ownership.
- Backend routes use `/api/v1`, strict Zod request/response validation, existing `{ error: { code, message } }` errors and server-derived identity. New HTTP codes retain that envelope. DTO timestamps use ISO UTC instants; calendar dates use `YYYY-MM-DD`.
- API role checks cover privileged repositories. Browser JWTs have no direct table mutation permissions. Harden all SECURITY DEFINER RPC execution grants; a restrictive table policy alone does not block an exposed privileged function.
- Cross-tenant or private foreign record IDs return `404 NOT_FOUND`; unauthenticated requests return `401 UNAUTHORIZED`; an authenticated caller lacking a same-tenant capability receives `403 FORBIDDEN`.
- The authenticated frontend first resolves `/me`, then loads authorized pages. JWT role/email metadata never grants application permissions. Cache keys include identity, family, role and access version; previous caches are destroyed on context transitions.
- Specifications 1 and 6 share transaction-boundary authorization: ordinary writes and access/entitlement changes serialize on a family lock, followed by actor membership, then resources in stable ID order. This prevents stale pre-handler permission checks from committing a forbidden mutation. No external HTTP call is made while holding those database locks.
- Database migrations append after `006`; allocate exact numeric filenames during implementation in merge order. Do not change previously applied migrations. Migrations use an execution ledger and verified staging rehearsal; historical README claims of arbitrary safe reruns are not assumed.
- Provider-facing code pins a tested SDK/API version during implementation. The source links in individual documents were checked on 2026-10-11; they establish capabilities, not approved pricing/legal policies.

## Ownership of shared contracts

| Contract | Owning specification |
| --- | --- |
| Identity, membership, `/me`, provisioning, API/RLS roles | 1 |
| OTP UI, provider configuration, neutral session recovery | 2 |
| Personal dashboard/history, aggregate leaderboard, role navigation | 3 |
| Explicit family creation, lifecycle, draft recovery | 4 |
| Billing customer/subscription, checkout, webhook inbox, portal | 5 |
| Entitlement projection, write gates, expiry, legacy rollout | 6 |

Each implementation branch changes both projects as needed. Contracts defined in prerequisites are reused, not independently redesigned. Read each document's traceability and completion checklist before considering its feature done.

## PRD coverage

| PRD requirement group | Primary specifications | Supporting specifications |
| --- | --- | --- |
| AUTH-01–03 | 2 | 1 identity verification |
| AUTH-04–09 | 1, 2 | 3 rendering gates; 4 explicit creation |
| MEM-01–08 | 1 | 2 email verification/recovery; 6 restricted-state revocation |
| VIEW-01–08 | 3 | 1 read authorization; 2 session cleanup; 6 billing restrictions |
| TEN-01–02 | 4 | 1 membership reservations |
| TEN-03–06 | 1, 4, 6 | 3 privacy; 5 payment recovery |
| BILL-01–03 | 5 | 1 owner identity; 4 tenant creation |
| BILL-04–09 | 5, 6 | 4 lifecycle |
| BILL-10 | 5 | 6 deployment rollout |

Specification 6 adds a narrow security-only revocation exception during read-only subscription access. This refines the PRD's write restriction for account safety; it does not enable member provisioning, profile edits or increased roles in that state. Review this policy alongside the other proposed decisions.

## Decisions still requiring review

Read-only members, manager delegation, global membership reservation, UTC leaderboard semantics, a single monthly Stripe plan, the seven-day renewal grace, restricted read-only access, legacy migration duration, outage tolerance and data retention remain proposed. Price, currency, member cap, tax behavior, merchant account and refund policy are unset. Specifications provide safe gates/placeholders rather than inventing these business values.

## Validation for implementation

Run backend/frontend tests and typechecks appropriate to each change; build both projects. Database acceptance requires a disposable `TEST_DATABASE_URL` plus staging Supabase Auth/RLS tests where a plain PostgreSQL harness cannot reproduce provider behavior. Do not count skipped database tests as isolation validation. Use provider test mode for billing; no production payments or account provisioning are authorized by these documentation changes.
