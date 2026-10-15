# Specification 6: Subscription entitlements and rollout

Date: 2026-10-11 · Status: Implemented; deployment and policy acceptance gated · Branch: `codex/subscription-entitlements`

Depends on specifications [1](01-tenant-membership-roles.md), [2](02-email-otp-login.md), [3](03-member-dashboard-history.md), [4](04-saas-tenant-onboarding.md), and [5](05-stripe-subscriptions.md). Source: [PRD](../product/PRD-family-access-and-saas.md); [shared conventions](README.md).

## Outcome and boundaries

Translate verified billing facts into household access, enforce the decision inside every product write, keep payment recovery available, and roll out paid SaaS without charging or disrupting existing families unexpectedly.

Membership is necessary but never sufficient for product writes. A paid family does not reactivate a revoked membership. This feature does not change score accounting, provider charge amounts, member read-only policy, owner transfer or permanent retention/deletion policy.

Proposed defaults for review: seven-day renewal grace, cancellation at paid-period end, existing established families read-only after expiry, temporary legacy access until an approved migration deadline, and at most 24 hours of provider-outage tolerance after a previously verified paid period ends. Do not enable production enforcement until these policies are approved and communicated. Trial capability remains disabled unless explicitly configured.

## Persisted projection and policy

Add `family_entitlements`, one row per family:

| Field | Meaning |
| --- | --- |
| `state` | DRAFT, ACTIVE, GRACE, READ_ONLY, LEGACY, or TRIAL |
| `source` | NONE, STRIPE or LEGACY_MIGRATION |
| `subscription_id` | Recognized local billing subscription; nullable for draft/legacy |
| `paid_through`, `trial_ends_at`, `grace_ends_at` | Verified/proposed cutoff facts; nullable when not applicable |
| `first_renewal_failure_at` | Start of one unresolved renewal failure episode; immutable during repeated retries |
| `legacy_ends_at` | Approved migration boundary; required before legacy enforcement is enabled |
| `verified_at`, `outage_tolerance_ends_at` | Last provider reconciliation and bounded access fallback deadline |
| `reason` | Safe internal category: PAYMENT_PENDING, PAID, RENEWAL_FAILED, CANCELED, UNPAID, PAUSED, LEGACY, TRIAL, PROVIDER_UNAVAILABLE |
| `version`, `policy_version`, `updated_at` | Monotonic snapshot/version and policy provenance |

Projection history is an immutable `entitlement_events` table with prior/new state, provider/inbox reference where relevant, reason, cutoffs, policy version and timestamp. Add a durable `billing_change_outbox` if not yet created by specification 5; unique billing snapshot version ensures retry-safe projection. Browser roles cannot write/read raw projection tables; safe state is exposed through `/me` and owner billing API.

Store policy versions explicitly; changing grace/outage policy does not silently extend a prior failure episode. Configuration requires approved `RENEWAL_GRACE_DAYS`, `PROVIDER_OUTAGE_TOLERANCE_HOURS`, trial allowance and legacy deadline. For test environments proposed values can be supplied with fake clock. No automatic numerical production fallback when missing approval/configuration.

## Projection algorithm

Process billing-change outbox with a leased worker. Under family lock, load current lifecycle, recognized subscription snapshot and existing entitlement. Apply only a newer fenced snapshot or a clock-driven boundary transition, increment version, append event, update lifecycle/established date when first entitled, and mark outbox processed in one transaction. No provider HTTP in this transaction.

| Input condition | Computed access state and cutoffs |
| --- | --- |
| SELF_SERVICE draft without confirmed qualifying payment | DRAFT; only owner onboarding and billing recovery |
| Confirmed qualifying paid period, correct plan/customer/mode | ACTIVE through paid-through, unless explicitly restricted by an approved exceptional policy |
| Approved provider trial | TRIAL through confirmed trial end; otherwise no trial activation |
| Renewal failure after previously confirmed paid access | ACTIVE until previous paid-through, then GRACE until fixed failure-episode cutoff; never grant grace for failed first payment |
| Scheduled cancellation during paid period | ACTIVE until paid-through; no new grace solely for cancellation |
| Canceled at/after paid-through | READ_ONLY for established families |
| Provider unpaid or paused | READ_ONLY; no new grace after terminal nonpayment. Previously confirmed paid-period handling follows approved cancellation/refund policy |
| Incomplete/incomplete_expired with no prior entitlement | DRAFT; retry payment without product data access |
| Expired GRACE/TRIAL/LEGACY with no qualifying payment | READ_ONLY if established; otherwise DRAFT |
| New verified qualifying subscription after restriction | ACTIVE; same established family/members/history restored |
| Verified legacy family before approved deadline | LEGACY; owner/manager normal role capabilities |
| Provider state ambiguous on first purchase | DRAFT/PAYMENT_PENDING; never optimistic activation |

Renewal failure cutoff is proposed as `max(previous_paid_through, first_renewal_failure_at) + approved_grace_duration`; fix one timestamp per unpaid episode. Repeated invoice failure events and worker retries cannot restart it. Successful recognized settlement clears that episode and advances paid-through according to verified coverage, not `now + one month`. Invoice/customer email is never tenant identity.

Scheduled cancellation blocks outage-based extension beyond its known paid-through date. A known canceled/unpaid/paused snapshot or confirmed grace expiry overrides any provider outage tolerance. Unknown or unrecognized provider statuses fail to restricted state and alert; do not treat any non-canceled string as paid. Refund/dispute events are recorded and quarantined for the approved exceptional-access policy; production release requires that policy, avoiding an invented entitlement decision.

Provider statuses alone cannot describe product entitlement; use confirmed coverage and configured policy. [Stripe subscription lifecycle](https://docs.stripe.com/billing/subscriptions/overview) documents distinct provider states; this state machine is the proposed application policy.

### Outage behavior

Within an already confirmed paid period, continue through its existing verified cutoff without synchronously calling Stripe on every request. If reconciliation is unavailable at a renewal boundary and no known cancellation/failure restriction applies, proposed temporary extension is bounded to `previous_paid_through + 24 hours`; approval/config determines exact value. Do not reset extension on each failed reconciliation. Record provisional outage reason and alert; it never activates a first purchase, restores a revoked member, extends scheduled cancellation or creates a permanent paid state. After tolerance expires, established views remain read-only and owner recovery stays available.

Database/app state unknown (e.g. projection row missing unexpectedly) fails closed to no writes with `503 ENTITLEMENT_UNAVAILABLE`, not unlimited legacy access. Membership resolution can still report safe recovery state if read capability is known. SQL/API policy must use the same cutoffs and database clock.

## Runtime enforcement and race guarantees

Authorization combines `active membership + role capability + lifecycle + current entitlement + operation target`. Roles remain authoritative for privacy and ownership even when billing disabled.

| Operation | DRAFT | ACTIVE/TRIAL/GRACE/LEGACY | READ_ONLY |
| --- | --- | --- | --- |
| Auth `/me`, logout, neutral recovery | All authenticated identities | Allowed | Allowed |
| Owner onboarding/profile/checkout/portal | Owner recovery only | Owner, according to flow | Owner recovery |
| Family views, board, leaderboard, awards | Denied to product users | Per role/self privacy | Per role/self privacy |
| Own/full authorized history | Denied | Per role | Per role |
| Task CRUD/move/complete/reopen | Denied | Owner/Manager only | Denied |
| Member provisioning/deactivation, role/email changes | Denied for new draft roster | Owner/Manager | Denied except security revocation |
| Templates/generate/carry-over and reward mutations/redemption | Denied | Owner/Manager | Denied |
| Established family profile edits | Denied; owner onboarding separate | Owner/Manager | Denied |
| Security-only login revocation | Owner recovery where a membership exists | Owner/Manager | Owner/Manager |

Security revocation exception is narrow: disabling login and revoking a session/membership only, with audit; it cannot edit profiles, enable access or increase roles. Add POST `/family/members/:id/access/revoke` with `{expectedVersion}` if the generic PATCH mixes denied edits. Owner remains protected. This exception prevents unpaid households retaining an unsafe member session indefinitely and is an explicit implementation refinement to the PRD restricted-write rule.

API pre-handler checks improve errors but are not the commit-time authority. All protected mutation functions acquire family lock, actor membership lock, then affected task/member/award rows in stable ID order; recompute role/lifecycle/entitlement using current database clock immediately before writes. Access-change and billing projection operations take the same family lock. If a revocation/restriction commits first, the mutation rolls back without task/ledger effects; a mutation that commits first remains valid and auditable. Deadlock retries are bounded and idempotent where applicable. Reopen/completion/redemption retain existing atomic transactions.

Strict expiration: authorization uses database `clock_timestamp()` at the write authorization point, not transaction-start time frozen by a long wait. Define that point as the linearization instant for a mutation; worker cleanup latency cannot extend access. Scheduled jobs carry explicit actor/system authorization and tenant entitlement, not a blanket service-role bypass.

Replace/upgrade every existing privileged mutation RPC and service write path, not just complete/redeem. Deny browser writes and old RPC overloads. RLS SELECT helpers require membership and lifecycle; raw history permissions still match role/self policies. Security revocation may be executed only through narrowly authorized backend operation. Product direct Supabase write grants never return when enforcement is disabled.

## API and frontend contract

Extend authorized `/me` branch with:

```ts
access: {
  state: 'DRAFT'|'ACTIVE'|'TRIAL'|'GRACE'|'READ_ONLY'|'LEGACY';
  reason: 'PAYMENT_PENDING'|'PAID'|'PAYMENT_ISSUE'|'EXPIRED'|'LEGACY'|'TRIAL'|'TEMPORARY';
  effectiveUntil: string|null;
  version: number;
  canManageBilling: boolean;
}
```

Public reason values are sanitized; only owner billing GET exposes payment failure details, invoices or provider status. `capabilities` is the intersection of role and access policy. Cache scope additionally includes entitlement version so a change clears stale editable UI. `state:'PAYMENT_REQUIRED'` is reserved for drafts; established READ_ONLY uses READY with restricted capabilities to preserve viewing access.

Write rejected due to paid access returns `403 SUBSCRIPTION_REQUIRED` with safe message in the existing envelope; owner UI links billing, member UI says “Your family currently has view-only access. Ask the family manager.” Revoked/missing membership is evaluated before subscription state, so attackers cannot discover someone else's paid status. Billing error is not treated as a 401/OAuth login request.

OWNER receives full grace/cancellation/legacy deadlines and recovery actions. MANAGER/MEMBER receive capability/limited access banner without amount, card/invoice or detailed payment status. Hide mutation controls on every page, including Wall and manager optimistic handlers. A concurrent server denial rolls back optimistic state and refreshes `/me`. Security revocation remains accessible to managers even in view-only mode.

On first activation, projection sets SELF_SERVICE family ESTABLISHED and `established_at` atomically with entitlement. Checkout status becomes activation CONFIRMED only afterward. Polling `/me` every 30 seconds/focus updates UI; server enforcement always immediate. No client countdown changes entitlement locally.

## Timers, worker and operational behavior

Run projection worker at least every 5 seconds with durable leases and retries. Boundary scheduler enqueues due grace/paid/trial/legacy/outage deadlines each minute. Authorization computes effective state lazily even if scheduler is late; GET `/me` presents effective state with a projection refresh queued. Persisted state is an audit/reporting projection, not permission to ignore an expired cutoff.

Reconcile billing hourly and pending purchase every minute through specification 5. Use one named deployment worker entrypoint or service, health/heartbeat and queue lag metrics; multiple workers must safely share leases. On restart, all unapplied outbox/deadline records remain recoverable. Never depend solely on browser activity to revoke writes.

## Existing-family migration and launch sequence

1. Rehearse new migrations/backfills on restored staging data. Record owner/member/task counts, per-family ledger sums, IDs and actor mappings before/after; resolve conflicts explicitly.
2. Deploy membership roles/API/RLS protection and neutral auth resolution; keep new purchase/signup disabled. Pilot OTP and member views with owned test families.
3. Deploy onboarding/billing workers in Stripe TEST mode and prove end-to-end activation, idempotency and restriction recovery. No live charge from migration or login.
4. Backfill existing LEGACY families with explicit migration eligibility source. Configured families receive LEGACY entitlement; incomplete ones can finish their original profile under legacy compatibility. No default legacy grant for SELF_SERVICE families.
5. Approve commercial settings, grace/outage/refund/retention policies, legacy deadline and communications. Business sends the migration notice through an authorized channel; this specification does not itself authorize contacting users.
6. Enable live checkout for a controlled cohort after provider account/price/portal/webhook mode validation. Activate enforcement for SELF_SERVICE cohort first; all cross-tenant role checks already apply globally.
7. Legacy owners see approved terms/deadline and can explicitly subscribe to their existing family. A paid confirmed subscription replaces LEGACY; cancellation cannot fall back to still-present legacy access. Record migration conversion consumed.
8. At announced legacy deadline, families without entitlement become READ_ONLY, never charged automatically or deleted. Owners retain subscription recovery. Expand only after pilot acceptance and monitoring.

Data retention duration/export/deletion procedures remain production launch gates. No automated cleanup job is included until these are approved. Owner auth deletion protection from specification 1 remains; a payment cancellation is not an account deletion request.

## Test and acceptance matrix

| Coverage | Required outcomes |
| --- | --- |
| Pure policy with fake clock | All states, paid-through equality, first-payment failure, fixed renewal grace, repeated retry, cancellation, trial disabled, legacy deadline, unknown provider status |
| Outage | Existing paid cutoff honored, fixed bounded extension, known cancellation/failure overrides, no first-purchase activation, no rolling extension |
| Role/access cross-product | Every mutation and view across Owner/Manager/Member, revoked status, DRAFT and established families |
| Transaction races | Complete/reopen/redeem and CRUD versus membership/entitlement change; no partial ledger writes or post-ordered restriction writes |
| Worker durability | Duplicate/out-of-order outbox, stale lease, restart, scheduler missed deadline and provider reconciliation; current snapshot wins |
| Lifecycle | First paid activation establishes same draft; restricted/resubscribed family retains all identifiers/history; old events cannot restore obsolete subscription |
| Legacy | Eligible backfill only; no automatic charge; incomplete profile resume; conversion consumed; deadline visible and enforced |
| Browser/API security | RLS/private history policies maintained; no direct writes/RPC bypass; security-only revoke exception cannot grant access |
| Frontend | Banners, hidden actions, owner portal recovery, ordinary member notice, optimistic rollback, cache entitlement version changes |
| Regression | Existing at-most-one-completion, award/reversal, redemption overspend, recurrence and IDOR tests pass against real database |

## Flags, rollback and completion

`ENTITLEMENT_ENFORCEMENT_ENABLED` plus persisted rollout cohort controls production gates; exact effective cohort/policy is resolved server-side and available to SQL authorization, never a frontend-only flag. Legacy mode is explicitly limited to migrated eligible families. New self-service drafts remain blocked unless confirmed entitled even before global enforcement.

Emergency controls: disable new checkout/signup independently; retain membership/RLS and existing subscription processing; keep read/recovery available. Enforcement rollback for a known cohort is an audited bounded operational exception with expiration, not treating all users as owners or all drafts as active. Workers and financial history remain running. Never revert schema destructively or erase ledger/entitlement events. Operator runbook includes scope, reason, expiry, verification and restoration steps.

Alert on projection/inbox lag, policy missing configuration, unknown provider status, role/access cache failures, deadline drift, worker heartbeat loss and unexpected ledger sum changes. Track checkout→activation p95 (proposed ≤60 seconds), recovery success and restricted-family counts. No raw email/payment details in analytics.

Completion requires six-feature staging acceptance, disposable DB transaction/policy tests, provider test lifecycle evidence, both app builds/typechecks, migration/rollback rehearsal and business approval of production gates. Specifications are complete when these contracts are documented; live rollout remains dependent on those approvals.

Traceability: TEN-03–06, BILL-04–09, MEM-04/05/08, VIEW-06–08, PRD quality requirements and section 10 migration/release scenarios.

Implementation and operational acceptance: [rollout guide](../implementation/06-subscription-entitlements-rollout.md). Production values require explicit environment configuration; proposed values above are not runtime defaults.
