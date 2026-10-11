# PRD: Family member access and subscription SaaS

Version: 1.0 · Date: 2026-10-11 · Status: Draft for product review

Product: Family Task Board / FamTask

## 1. Product intent

Enable family members to sign in using a code sent to their email, reach the correct family, and use the permissions assigned by their manager. Turn each family into an isolated subscription tenant that a responsible adult can purchase and manage, with Stripe as the proposed billing provider.

This document defines product behavior and acceptance criteria. API contracts, database designs, detailed test plans, and implementation tasks belong in the subsequent feature specifications. No implementation or branch creation is part of this PRD stage.

The two requested capabilities are confirmed scope. Policies identified as **proposed** are product recommendations, not previously approved decisions. Commercial decisions in section 11 must be resolved before billing implementation or paid launch.

## 2. Repository findings and baseline

All three project README files were reviewed: root `README.md`, `backend/README.md`, and `frontend/README.md`. Exploration also covered application composition, authentication, context and authorization middleware, domain services and repositories, SQL migrations, frontend routes, pages, API types, hooks, realtime, package manifests, and existing test coverage. The historical requirements and design in `.kiro/specs/family-task-board-backend/` were consulted for context; they describe the previous Base44 migration and are not an accurate current-state inventory.

| Area | Current behavior | Product implication |
| --- | --- | --- |
| Backend | Fastify + TypeScript REST API, Supabase PostgreSQL and JWT verification | Extend the existing service; no platform rewrite required |
| Frontend | React JSX, Vite, Tailwind, TanStack Query, typed REST modules | Preserve existing screens and add role-aware flows |
| Login | Google OAuth only in the UI | Add email code login while retaining Google |
| Bootstrap | `GET /api/v1/me` creates a responsible user and default family for every new identity | Resolve membership before any family creation; member login must never silently create a family |
| Ownership | One family per responsible user through a unique ownership reference | Preserve the existing owner while introducing authenticated memberships |
| Members | Name, PARENT/CHILD/DEPENDENT type, avatar, color, birth year, active flag; no member email, auth link, or permission role | Add explicit access provisioning independent of descriptive family type |
| Permissions | Family ownership checks; no manager/member capability gates | Introduce enforced roles, not just different navigation |
| Data access | Domain repositories use the service-role client, bypassing RLS; owner-based RLS governs direct authenticated database access | API authorization and database policies both need review; README/design claims about RLS protecting backend reads must not be assumed |
| Points | Atomic completion, reversal and redemption; balances derived from ledger | Preserve accounting behavior and historical identifiers |
| Actor identity | Task creation and completion actors reference `responsible_users` | General member writes would require an actor-model change; proposed MVP keeps member views read-only |
| Views | Home, Board, Members, Leaderboard, Wall, Settings, Templates, Member Profile, Points History, Awards, Onboarding | Reuse views with role-specific data and controls |
| Leaderboard/history | Frontend leaderboard derives results from family-wide ledger; points history uses family-wide reads | Members need authorized aggregate rankings without receiving everyone's transaction history |
| Realtime/cache | Family-filtered subscriptions; query keys are generally not tenant/user scoped | Access transitions must clear or partition caches and subscriptions |
| Billing | Stripe frontend dependencies exist; no billing workflows, backend billing module, or subscription schema found | Dependencies alone do not constitute an integration |

Key evidence: `backend/src/modules/auth/auth.service.ts`, `backend/src/middleware/context.ts`, `backend/src/middleware/authorization.ts`, `backend/src/modules/members/member.schemas.ts`, `backend/src/supabase/migrations/001_initial_schema.sql`, `003_rls.sql`, `004_functions.sql`, `frontend/src/lib/AuthContext.jsx`, `frontend/src/components/Layout.jsx`, `frontend/src/hooks/useFamily.js`, `frontend/src/hooks/useRealtime.js`, and the existing page implementations.

This PRD intentionally supersedes the historical Google-only/no-member-login assumptions, automatic family creation on every first login, and owner-only access model. It preserves existing task, recurrence, ledger, reward and manager workflows unless explicitly changed below.

## 3. Goals, personas and scope

### Goals

1. A provisioned member can authenticate without a Google account and immediately see their family and assigned permissions.
2. Managers control access without giving away their own session or account.
3. Members can see their work, points, history, family board and leaderboard safely.
4. Each paying family has isolated data and one subscription covering the household.
5. Billing failures and cancellation produce predictable access behavior without losing family history.

### Personas

- **Owner:** the responsible adult who creates the family and controls its subscription. Existing responsible users become owners during migration.
- **Manager:** a person the owner or an authorized manager grants household management access to. Billing ownership remains distinct.
- **Member:** a participant associated with a manager-created family member record and granted personal/family viewing access.
- **Participant without login:** a child or dependent represented in the family board but without an email-enabled account.
- **Prospective owner:** an authenticated person who explicitly chooses to create and subscribe to a family.

### MVP scope and boundaries

Include email OTP, retained Google login, email-to-member association, manager-assigned roles, access revocation, member views, tenant isolation, paid subscription onboarding, billing self-service, entitlement enforcement, migration and operational observability.

**Proposed MVP:** one family equals one tenant; one paid plan billed monthly per family; one owner with optional additional managers; ordinary members have read-only access. A login email maps to one family in MVP. No-login participant records remain supported.

Exclude passwords, custom roles, public leaderboards, member self-assignment, member task completion or reward spending, organization hierarchies, tenant switching, multiple owned tenants, dedicated databases per tenant, custom domains, usage billing, coupons, annual plans, and a new platform administration UI. These can be considered later. Ordinary members must not perform writes until a separately specified policy authorizes them.

## 4. Access model and permissions

`PARENT`, `CHILD`, `DEPENDENT`, and the owner's `relationship` describe people; they never grant permissions. Access roles are OWNER, MANAGER and MEMBER. New login-enabled member records default to MEMBER. A manager explicitly selects the access role during creation or authorized editing.

| Capability | Owner | Manager | Member |
| --- | --- | --- | --- |
| Family dashboard and board | Full | Full | View; personal summary emphasized |
| Family leaderboard | View | View | View aggregate rankings |
| Points/completion history | All family members | All family members | Own detailed history only |
| Member profile | All | All | Own full profile; others' public display information only |
| Awards catalog | View/manage | View/manage | View |
| Task CRUD, assignment, movement, completion, reopening | Yes | Yes | No |
| Recurring templates, generation and carry-over | Yes | Yes | No |
| Reward redemption | On behalf of members | On behalf of members | No |
| Roster, login emails, access roles and revocation | Yes | Yes, except owner | No |
| Family settings | Yes | Yes | No |
| Subscription, invoices, payment method, cancellation | Yes | No | No |
| Wall Mode | Existing controls | Existing controls | View only |
| Create/remove/change owner or delete tenant | Owner-controlled future flow | No | No |

**Proposed:** managers may provision other managers, but cannot change the owner or gain billing access. Owner transfer and tenant deletion UI are deferred; account deletion must not silently cascade into loss of an entire paid family. Ownership protection must be specified before release.

Permissions apply equally to API requests, direct Supabase access, realtime events, deep links and UI controls. Subscription entitlements may further restrict capabilities; a valid session alone grants neither tenant access nor a paid entitlement.

## 5. Feature A: Email authentication and membership resolution

### Core journey

1. Manager creates or edits a family member, optionally enables login, supplies an email, and selects MEMBER or MANAGER.
2. The application shows that access is provisioned but not yet claimed. Adding an email does not prove its ownership. An invitation email may explain how to sign in; it is not required to establish permissions.
3. Member chooses “Continue with email,” enters the email, receives a code and submits it.
4. Authentication verifies control of the mailbox. The backend matches the verified identity to the active provisioned membership, binds it safely, and resolves the family and role.
5. MEMBER reaches the family dashboard with personal points, recent activity and assigned tasks. MANAGER reaches the management dashboard. Neither is sent through family creation onboarding for an existing configured family.

“Analyze the email” means deterministic lookup against manager-provisioned membership records after verification. Never infer a family or role from an email domain, name, provider, or client-supplied profile metadata.

### Requirements

| ID | Requirement and acceptance outcome |
| --- | --- |
| AUTH-01 | Login presents email code and Google choices. Email login requires no password or Google account. Logout and expired-session recovery return to the login choices instead of automatically starting Google OAuth. |
| AUTH-02 | OTP UI supports paste/autofill, resend cooldown, change-email, loading, delivery failure, invalid/expired code and retry. Errors do not reveal whether an email belongs to a family. |
| AUTH-03 | Proposed code lifetime: 10 minutes; resend cooldown: at least 60 seconds. Codes are single-use; verification/request throttling and abuse handling are specified and validated with the provider before release. A failed attempt never authenticates. |
| AUTH-04 | Resolve access only from authenticated, verified identity and active server-owned membership. Initial email association is atomic and cannot overwrite a different already-linked identity. Concurrent first logins produce one association. |
| AUTH-05 | After association, the stable authentication identity resolves access. A changed email cannot silently rebind an account to another member; changes require a controlled verification and reassignment flow. |
| AUTH-06 | Provisioned members without an existing auth account can complete first OTP login. Creation of an authentication identity is distinct from creation of an application tenant. |
| AUTH-07 | A verified identity with no membership sees “No family access” and an explicit “Create a family” option. It does not receive an automatically created family or manager role. |
| AUTH-08 | Existing owner Google accounts continue reaching their original family. Email and Google authentication for the same verified identity must not create duplicate families or reset roles. Conflicting provider identities fail safely and require a defined recovery path; client metadata cannot merge them. |
| AUTH-09 | Membership-resolution failures block family pages and display a recoverable error. Authentication success must not release the app before authorized context is available. |

### Membership lifecycle and edge cases

| ID | Requirement and acceptance outcome |
| --- | --- |
| MEM-01 | Login email is optional for no-login participants and required when login is enabled. Access role is visibly distinct from family member type. Managers can see provisioned/claimed/revoked access state without exposing auth secrets. |
| MEM-02 | Proposed matching policy: trim surrounding whitespace and compare case-insensitively; preserve the entered address for display. Do not strip plus suffixes or Gmail dots. Specification must reconcile normalization with provider behavior. |
| MEM-03 | One normalized login email may belong to only one login-enabled membership across families in MVP, including owner identities. Duplicate or conflicting assignments are rejected with a generic conflict that does not disclose another family. No duplicate is resolved by choosing the first result. |
| MEM-04 | Removing login access, deactivating a member, or changing roles takes effect on the next authorized request and terminates unauthorized realtime access. Existing sessions cannot retain previous permissions. UI refresh is proposed within 30 seconds. |
| MEM-05 | Revocation preserves the member record, tasks, points, and history. Re-enabling the same person restores access to the same record, not a new balance. |
| MEM-06 | Changing a login email requires manager authorization and verification of the new mailbox. Old access is revoked before new access is granted; claimed identities cannot be silently reassigned. Exact recovery and relinking sequence belongs in the specification. |
| MEM-07 | Shared mailboxes do not enable multiple distinct member identities in MVP. No-login children/dependents remain fully usable in manager workflows. |
| MEM-08 | The owner cannot be removed/demoted by a manager or accidentally disabled through member editing. Access changes record authenticated actor, affected membership, action and timestamp. |

## 6. Feature B: Member experience

| ID | Requirement and acceptance outcome |
| --- | --- |
| VIEW-01 | The member home displays family/name context, own current points balance, assigned tasks, recent completed work and shortcuts to Board, My History, Leaderboard and Awards. Empty states explain when no tasks/history exist. |
| VIEW-02 | The board supports current weekly/date/status views and shows the family task board. Members may filter tasks but cannot create, drag/move, complete, edit, reopen or delete them. Family-shared task titles/descriptions must be explained to managers. |
| VIEW-03 | My History shows only the caller's ledger and completion details, including earned points, reversals and redemptions with correct timestamps. Earned, spent, reversed and net totals are distinguished; a redemption is not labeled a reopened task. |
| VIEW-04 | Leaderboard exposes family display names, avatars/colors, rank and aggregate scores/completion counts for today/week/month/all time. It does not send other members' raw ledger rows to a member client. |
| VIEW-05 | Existing ledger-derived scoring remains unchanged unless separately approved. Period boundaries, ties, redemptions and reversals use one authoritative calculation for all roles. Validate frontend/backend parity rather than inheriting current client date-field assumptions. |
| VIEW-06 | Member navigation omits Members management, Templates, family Settings, billing and creation onboarding. Direct URLs and manipulated member/task identifiers enforce the same restrictions. |
| VIEW-07 | Member Wall Mode remains authenticated and view-only. Manager Wall Mode retains authorized actions. A shared display does not grant new permissions or expose billing details. |
| VIEW-08 | Changing account or permissions clears protected caches and old subscriptions before rendering the new context. A member never briefly sees cached manager-only history or another family's data. |

Full family board and aggregate rankings are intentionally shared; detailed history is personal. Member email, birth year, authentication state, billing information and security audit records are not shared roster fields.

## 7. Feature C: SaaS tenancy and paid onboarding

The existing family ID is the proposed tenant boundary. “Having a tenant” means an isolated family workspace, not a separate Supabase project. Household subscription entitlement applies to all authorized people in that family.

### Prospective-owner journey

Authenticate → explicitly choose Create a family → enter required family/owner details → see plan and recurring price → enter hosted checkout → show payment-processing state until confirmed → open the configured family dashboard → add members and tasks.

**Proposed:** preserve an unpaid draft family to support checkout retry. Draft access is limited to onboarding and owner billing; ordinary app usage and member access begin after entitlement activation. Repeating onboarding or checkout recovery must reuse the draft tenant.

| ID | Requirement and acceptance outcome |
| --- | --- |
| TEN-01 | Tenant creation is an explicit action for an eligible authenticated prospective owner. An invited/provisioned member is routed to their existing tenant and cannot accidentally create another through sign-in. |
| TEN-02 | MVP supports one tenant per account and one owner per tenant. A person already owning/belonging to another tenant receives a clear limitation without disclosure of unauthorized data. Future tenant switching requires its own specification. |
| TEN-03 | Family records, tasks, templates, completions, points, awards, memberships and billing state are scoped to the authorized tenant. Foreign resource references remain indistinguishable from nonexistent resources. |
| TEN-04 | API guards enforce role, membership status, tenant ownership and subscription capability. RLS and realtime enforce equivalent access for browser JWTs. Direct database APIs cannot bypass restrictions. |
| TEN-05 | Login, membership resolution, payment recovery and owner billing remain available when the tenant loses its paid entitlement. Restrict product capabilities without locking owners out of payment repair. |
| TEN-06 | Tenant operations preserve existing atomic points and recurrence guarantees. Billing access transitions cannot allow partially committed ledger changes or skip authorization. |

## 8. Feature D: Subscription billing

**Proposed provider:** Stripe Billing with hosted Checkout and Customer Portal. Hosted Checkout supports subscription purchase; Customer Portal supports payment methods, invoices and subscription self-service. Confirm applicable merchant country, currency and payment methods before commercial launch. See [Stripe subscription overview](https://docs.stripe.com/billing/subscriptions/overview) and [Customer Portal documentation](https://docs.stripe.com/customer-management).

### Commercial model

Proposed launch offer: one monthly recurring plan per family, paid by the owner, with the same household feature set for all paid tenants. Price, currency, member cap, taxes, trial, refunds and retention remain TBD. No numerical price or legally binding terms are implied by this document. A trial/free plan is not assumed.

| ID | Requirement and acceptance outcome |
| --- | --- |
| BILL-01 | Before payment, show recurring price/currency, billing interval, included features/limits, cancellation terms and applicable taxes. Values come from approved plan configuration; the browser cannot choose an arbitrary price or quantity. |
| BILL-02 | Only the tenant owner can start checkout or open its billing portal. Stripe customer/subscription associations are tenant-owned; neither a supplied customer ID nor email alone authorizes access. |
| BILL-03 | Prevent duplicate active subscriptions through repeated clicks, concurrent sessions or retries. Reuse existing billing association or direct the owner to manage it. |
| BILL-04 | Checkout success redirect does not grant entitlement. Confirm payment/subscription state through authenticated provider integration, then activate the same draft tenant. Delayed confirmation shows a processing/retry state; a canceled checkout leaves a recoverable draft. |
| BILL-05 | Handle provider subscription/payment events with signature verification, durable processing, idempotency, retries and reconciliation. Duplicate/out-of-order deliveries cannot double-create tenants, double-charge through app actions or reinstate an obsolete entitlement. |
| BILL-06 | Billing view shows current plan, recurring price, subscription/access status, renewal or end date and payment-recovery action. Owner can update payment method, view invoices and cancel via hosted self-service. |
| BILL-07 | Cancellation is proposed at period end. Paid access continues through the confirmed paid-through date, then transitions to restricted mode. Resuming before expiration or re-subscribing later restores the same family's data. |
| BILL-08 | Failed renewal presents an owner recovery notice and clear member-facing access message without payment details. Ordinary members are never asked to pay on behalf of the family. |
| BILL-09 | Cancellation/failure does not delete members or history. A separately disclosed retention/deletion policy governs permanent removal. Refund behavior and its entitlement effects must be decided before paid launch. |
| BILL-10 | Test/live provider environments are separated. Card data and payment credentials remain outside application storage and logs; billing secrets remain backend-only. |

Stripe delivers subscription lifecycle changes asynchronously; product access therefore needs an explicit entitlement projection and recovery process. This is a product inference from [Stripe subscription webhook guidance](https://docs.stripe.com/billing/subscriptions/webhooks), not existing application behavior.

### Proposed access policy

| State | Family capability | Owner action |
| --- | --- | --- |
| Unpaid draft / checkout incomplete | Onboarding only; no member product access | Complete or retry checkout |
| Active and entitled | Capabilities in role matrix | Manage billing |
| Trialing, if later approved | Capabilities in role matrix through trial end | Add payment method / subscribe |
| Renewal past due | Full access during proposed 7-day grace, bounded by configured policy | Repair payment; show grace end |
| Scheduled cancellation, still paid | Full access through paid-through date | Resume if permitted |
| Grace expired, unpaid, canceled after paid-through date, paused, or expired checkout | Existing authorized family views read-only; no task/roster/award writes | Recover subscription |
| Subscription state unknown during first purchase | No activation until confirmed | Processing and recovery message |
| Provider outage after previously confirmed entitlement | Honor last confirmed entitlement only within a specified bounded tolerance | Recovery notice if relevant |

These are application access policies, not a direct one-to-one mapping of Stripe statuses. Exact status/event mapping, timer behavior, outage tolerance and manual payment handling must be specified. The proposed seven-day grace requires confirmation. Membership revocation always overrides any paid or grace state.

## 9. Quality, security and operations

- Validate all role/cross-tenant/self-history restrictions at the API and database layers. A service-role client bypasses RLS, so RLS alone cannot demonstrate API security.
- Do not log email codes, sessions, credentials, payment secrets or unnecessary personal data. Access and billing audits capture actions without exposing sensitive payloads.
- Production email delivery needs a configured sender, delivery monitoring and provider abuse controls. Supabase supports email OTP and requires a code-oriented email template; implementation must distinguish auth-user creation from tenant creation. See [Supabase passwordless email documentation](https://supabase.com/docs/guides/auth/auth-email-passwordless).
- Proposed usability targets: after code verification, dashboard ready within 3 seconds at p95 under agreed pilot conditions, excluding email delivery; confirmed payment reflected within 60 seconds at p95 under normal provider operation. Specifications must define measurement boundaries and degradation behavior.
- Email code inputs, error notices, role navigation and billing states support keyboard use, screen readers and mobile layouts. Preserve existing Wall Mode readability and reduced-motion behavior.
- Add monitoring for OTP failures/delivery issues, membership-resolution failures, authorization denials, webhook lag/failures, entitlement drift and checkout activation failures. Provide an operator recovery procedure without requiring a new admin UI.
- Minimize data collected for children/dependents. Existing no-login participants remain supported. Launch-market consent, privacy, tax and retention requirements need accountable business decisions rather than assumptions about geography.

## 10. Migration and release acceptance

1. Backfill existing responsible users as owners of their current family; preserve auth IDs, family IDs, member IDs, points and historical actor references.
2. Leave existing family members without email/login disabled until explicitly provisioned. Never invent email addresses, infer access roles from PARENT/CHILD/DEPENDENT, or reset history.
3. Preserve existing owner Google login and configured-family routing. Identify verified identity conflicts before activating email claims.
4. Do not enable broad authenticated member access under current owner CRUD policies. Release API role checks, database policies and role-aware frontend coherently.
5. Introduce authentication and member access before enforcing paid access. Billing enforcement stays disabled until webhook/reconciliation behavior and existing-family commercial migration are ready.
6. Do not retroactively charge or restrict existing families without a communicated and approved policy. Proposed rollout: temporary legacy entitlement until the business decides a migration window; this is not a promised permanent free plan.
7. Pilot with controlled families, exercise Stripe test flows, verify ledger invariants and expand only after acceptance. Rollback may disable new provisioning/billing gates while preserving existing memberships and financial audit data; it must never restore full manager access to members.

### Required release scenarios

| Scenario | Passing outcome |
| --- | --- |
| Provisioned member, first email login | Existing member/family/role resolved; no extra responsible family created |
| Owner signs in with Google and supported email identity | Same owner, family, tasks and points |
| Wrong, expired or reused code | No authenticated access; useful retry message |
| Unrecognized email | No automatic family; explicit creation choice after verification |
| Duplicate email or concurrent first claims | Deterministic conflict or single safe association; no privilege escalation |
| Member guesses manager URL or submits manager API write | Denied with no mutation |
| Member changes history filter or queries Supabase directly | Cannot obtain another member's detailed ledger/private profile |
| Member sees leaderboard | Correct family aggregate ranks without raw family ledger disclosure |
| Role change/deactivation while logged in | Next request enforces new access; stale cache/subscriptions cleared |
| Family A supplies Family B identifiers | No read, write, billing or realtime leakage |
| Duplicate/concurrent checkout and webhook deliveries | One intended subscription association and tenant activation |
| Checkout returns before payment confirmation | Processing state; no unconfirmed paid access |
| Failed renewal, recovery and grace expiration | Access follows approved policy; owner can repair payment |
| Period-end cancellation and re-subscription | Access ends at correct boundary; historical data survives and returns |
| Provider downtime or missed webhook | Bounded access policy and reconciliation; no indefinite accidental entitlement |
| Existing-family migration | Ownership, configuration, points, recurrence and reward workflows retained |

Validation must include real database policy/integration coverage, not only mocks. Existing database suites skip without `TEST_DATABASE_URL`; a passing default test command alone will not certify tenant isolation or ledger behavior.

## 11. Decisions for product review

| Decision | Proposed baseline | Required by |
| --- | --- | --- |
| Member actions | Read-only MVP; managers perform completion/redemption | Access specification |
| Access roles | Owner + Manager + Member; owner alone handles billing | Membership specification |
| Manager delegation | Managers may appoint managers; owner protected | Membership specification |
| Multiple-family accounts | Unsupported in MVP; globally unique login membership | Identity/tenancy specification |
| Shared views | Full family board and aggregate leaderboard; own detailed history | Member-view specification |
| Subscription unit/provider | Family tenant; Stripe hosted billing | Billing specification |
| Price, currency, markets and member cap | TBD; one monthly plan recommended | Billing configuration and paid launch |
| Trial/free tier | None assumed | Purchase-flow specification |
| Renewal failure | Proposed 7-day grace, then read-only | Entitlement specification |
| Cancellation/refunds | Period-end cancellation proposed; refund policy TBD | Billing specification and paid launch |
| Existing families | Temporary legacy entitlement; migration notice/window TBD | Enforcement rollout |
| Retention, export/deletion and owner account deletion | Preserve unpaid data; durations/process TBD; protect family against accidental cascade | Migration specification and paid launch |
| OTP policy and provider identity conflicts | Proposed 10-minute expiry; controlled verified recovery | Authentication specification |
| Merchant, email sender and operational owners | Business/account configuration TBD | Production launch |

## 12. Success measures

Track the first four weeks of pilot usage; the following targets are proposed and require a baseline:

- At least 95% of valid provisioned-member attempts with a correctly supplied code reach the correct dashboard without assistance.
- Zero extra tenants created by provisioned-member login; zero successful cross-tenant/role-boundary violations in release acceptance.
- At least 95% of confirmed successful first purchases activate the correct tenant within 60 seconds under normal provider operation.
- Measure manager-to-member access activation rate, weekly active members per family, checkout conversion, payment recovery rate and subscription retention; establish targets after pilot baseline.
- Zero historical ledger loss, duplicate subscription activation, or member access remaining after revocation in acceptance scenarios.

Analytics events should cover code request/verification outcomes, membership resolution, access activation/revocation, first member dashboard, checkout started/confirmed, entitlement transitions and recovery. Use internal identifiers; do not put OTPs or raw email addresses in analytics.

## 13. Next-stage specifications and separate feature branches

Create one specification per feature below after product decisions are reviewed. Proposed branch names use the repository's `codex/` convention. Each branch can include both backend and frontend changes needed to deliver that feature; do not divide a feature into disconnected frontend/backend releases.

| Order | Feature specification / proposed branch | Dependencies and deliverable |
| --- | --- | --- |
| 1 | Access foundation — `codex/tenant-membership-roles` | AUTH-04–09, MEM-01–08, TEN-02–04; identity/membership model, owner migration, context resolution, API/RLS authorization and provisioning; member login must be safe before OTP UI ships |
| 2 | Email OTP — `codex/email-otp-login` | Foundation; AUTH-01–09; email delivery configuration, code UX, identity conflict/recovery, neutral session recovery |
| 3 | Member experience — `codex/member-dashboard-history` | Foundation + login; VIEW-01–08; role navigation, personal dashboard/history, aggregate leaderboard, view-only board/Wall and cache isolation |
| 4 | Explicit SaaS onboarding — `codex/saas-tenant-onboarding` | Foundation; TEN-01–06; explicit creation, recoverable unpaid draft, owner journey; deploy with billing enforcement disabled until ready |
| 5 | Stripe subscription — `codex/stripe-subscriptions` | Onboarding + approved commercial settings; BILL-01–10; checkout, customer association, webhook processing, portal and reconciliation |
| 6 | Entitlements and rollout — `codex/subscription-entitlements` | Billing + approved lifecycle/legacy policy; backend write gates, restricted states, expiration/recovery, migration and pilot rollout |

Each specification must define contracts, persisted states/invariants, authorization by operation, frontend states, migration/backfill, provider configuration, error behavior, observability, meaningful tests, release flags and rollback. Map acceptance criteria to the IDs in this PRD. Separate branches do not imply independence: merge prerequisites in order and keep incomplete customer flows behind controlled release flags.

## 14. External references

Provider capabilities checked on 2026-10-11. Policies proposed here belong to this product and should not be confused with provider defaults.

- [Supabase email OTP and passwordless authentication](https://supabase.com/docs/guides/auth/auth-email-passwordless)
- [Stripe subscription lifecycle](https://docs.stripe.com/billing/subscriptions/overview)
- [Stripe subscription webhooks](https://docs.stripe.com/billing/subscriptions/webhooks)
- [Stripe hosted customer billing portal](https://docs.stripe.com/customer-management)
