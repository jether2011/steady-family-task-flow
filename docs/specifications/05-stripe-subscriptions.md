# Specification 5: Stripe subscriptions

Date: 2026-10-11 · Status: Design draft · Branch: `codex/stripe-subscriptions`

Depends on [roles](01-tenant-membership-roles.md), [explicit onboarding](04-saas-tenant-onboarding.md), and approved merchant/plan settings. Source: [PRD](../product/PRD-family-access-and-saas.md); [shared conventions](README.md).

## Outcome and boundaries

The owner purchases one monthly family subscription with hosted Checkout and manages payment/invoices/cancellation through a hosted billing portal. Persist verified lifecycle events and reconcile provider state. Specification 6 owns capability enforcement and expiration policy; this branch supplies authoritative billing facts and an integration seam.

No in-app card fields, annual/multiple plans, quantity billing, arbitrary upgrades, trial by default, discounts, manual invoices, Connect, payouts, custom refund UI or production charging during implementation. Existing frontend Stripe packages are not used to collect card data for hosted checkout. Add the official server SDK, pin a tested API version and verify exact event/object shapes with that version.

## Commercial and environment configuration

Required before purchase enablement: approved recurring amount/currency, plan title/features/member limit policy, merchant country/account, supported payment methods, tax behavior, terms/privacy links, refund/cancellation policy and existing-family rollout policy. No default numerical price or cap.

Backend validated configuration:

| Key | Purpose |
| --- | --- |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Server secrets, masked in all diagnostics |
| `STRIPE_PRICE_ID` | Approved recurring monthly price; allowlist one price |
| `STRIPE_PORTAL_CONFIGURATION_ID` | Owner portal configuration with approved period-end cancellation behavior |
| `PUBLIC_APP_URL` | Approved HTTPS frontend origin used to construct return URLs; localhost allowed only in dev |
| `STRIPE_MODE` | TEST/LIVE; validate key/event environment and persisted associations |
| `BILLING_AVAILABLE`, `CHECKOUT_ENABLED` | Server capability/kill switches; checkout defaults false |

Plan configuration is validated against provider price/product before enabling checkout. Tax and payment-method parameters are selected explicitly after approval, not left to undocumented commercial defaults. Environment and account IDs are recorded with billing objects so staging events cannot update live state. Frontend needs no Stripe secret or publishable key for server-created hosted sessions.

## Persistence and constraints

| Entity | Fields/invariants |
| --- | --- |
| `billing_accounts` | One per family per provider environment; unique provider customer ID; mode, merchant/account reference, creation status, timestamps |
| `billing_subscriptions` | Unique provider subscription ID/environment; family/customer FK; price ID, status, cancellation flags/end, current period facts, trial end if allowed, latest invoice ID/status, paid-through evidence, last reconciliation time; append old subscriptions rather than replace history |
| `billing_checkout_attempts` | UUID attempt, family, owner app-user, request key/hash, mode/price, provider session ID/url/expiry, CREATING/OPEN/COMPLETED/EXPIRED/FAILED/UNKNOWN, lease, timestamps; unique request key in family; at most one unresolved attempt per family |
| `billing_events` | Unique mode/account/provider event ID; type/object references, payload or minimized encrypted payload, received/provider-created timestamps, PENDING/PROCESSING/APPLIED/FAILED/IGNORED, attempt count, retry/lease times, sanitized error; durable inbox |
| `billing_audit_events` | Actor where available, tenant, provider refs, operation/result, correlation ID/time; no card/token data |

Browser roles have no direct billing table grants. Owner data is returned through authorized DTOs; manager/member receive only entitlement/access notices in specification 6. Inbox payload retention is an explicit operations policy before production, not indefinite collection.

## REST and ownership contracts

Routes below `/api/v1`. Owner gates derive tenant, owner and provider customer from current membership; no client customer/subscription/family ID is accepted.

| Method/path | Request | Result |
| --- | --- | --- |
| GET `/billing/plan` | Authenticated; no body | `{planKey:'family-monthly', title, currency, unitAmount, interval:'month', features, memberLimit:null|number, termsUrl, taxDisclosure, available}`; no purchase if settings unapproved |
| GET `/billing/subscription` | OWNER only | `{plan, status, cancelAtPeriodEnd, paidThrough, nextBillingAt, accessState, recoveryAction, updatedAt}`; unavailable facts null, never invented |
| POST `/billing/checkout` | `{planKey:'family-monthly'}` + UUID Idempotency-Key | 201 `{attemptId,url,expiresAt}`; existing attempt 200; 202 `{attemptId,state:'PROCESSING'}` if uncertain creation; validate URL provider-owned |
| GET `/billing/checkout/:attemptId` | OWNER and same family | `{attemptId,state,activation:'PENDING'|'CONFIRMED'|'FAILED',nextAction}`; no card details |
| POST `/billing/portal` | Empty strict body | `{url}`; fresh short-lived hosted portal session using stored customer, configured return URL |
| POST `/billing/webhooks/stripe` | Raw signed provider body | 200 `{received:true}` after durable inbox commit; 400 invalid signature/body; 503 durable storage unavailable |

Only webhook endpoint skips Supabase authentication and instead verifies provider signature on exact raw body, signed timestamp tolerance and configured endpoint secret. Register its parser in an encapsulated Fastify scope outside auth/context middleware; keep probes unchanged. Bound body size and header processing. A received valid but unsupported event is safely marked IGNORED. Never log raw webhook body or signatures.

Error contract: `409 SUBSCRIPTION_EXISTS` with safe owner recovery action through billing GET; `409 IDEMPOTENCY_CONFLICT`; `422 PLAN_UNAVAILABLE`; `503 BILLING_UNAVAILABLE`; owner-only 403; cross-family attempt ID 404. Payment declines appear as safe payment recovery states, not raw provider exception details.

## Checkout orchestration and duplicate prevention

1. Authorize current OWNER, completed profile and eligible DRAFT/established resubscription state. Read plan server-side; reject client amount/quantity/currency/price fields.
2. Under short family lock, inspect current subscription and unresolved attempt. If provider state is stale/ambiguous, schedule reconciliation and return PROCESSING rather than opening another session. Paid/trial/past_due/unpaid subscriptions route to portal/recovery; they do not get another checkout.
3. Reserve attempt and provider idempotency keys; release database lock before provider HTTP. Concurrent caller reuses the attempt. Use durable worker lease for creation; timeout moves to UNKNOWN, not FAILED-ready-for-new-charge.
4. Create/reuse the family's provider customer with stable operation key. Then create Checkout with `mode:'subscription'`, stored customer, allowlisted price, quantity 1 and approved success/cancel URLs. Put opaque family/attempt references in session and subscription metadata for validation; metadata itself does not authorize association.
5. Persist session references. Unknown response is retried with identical parameters/key within provider retention; if ambiguity persists beyond retention, reconcile provider session/customer/subscription records before allowing a new attempt. Never blindly issue a fresh key after timeout.
6. Return hosted URL. New attempt allowed only after previous session is confirmed expired/terminal and associated subscription cannot incur a concurrent charge. Re-subscription creates a new subscription record for the same family/customer after confirmed termination.

Example success URL: configured origin + `/billing/return?attempt=<opaque-id>`; cancel URL `/subscribe?checkout=canceled`. Frontend supplied URLs are prohibited. Return page polls owner checkout status with capped exponential intervals (2,4,8 seconds, then 10 seconds) for two minutes and offers explicit retry/recheck. Navigate home only after server activation CONFIRMED. Close/reopen/relogin recovers attempt through subscription/onboarding state.

Provider API retry keys support retries; the application attempt table is the durable duplicate-prevention authority after provider key expiry. See [Stripe idempotency documentation](https://docs.stripe.com/api/idempotent_requests) and [Checkout session creation](https://docs.stripe.com/api/checkout/sessions/create).

## Webhook processing and reconciliation

Required event families for pinned API version: `checkout.session.completed`, `checkout.session.expired`, async payment success/failure if approved methods use them; `customer.subscription.created/updated/deleted`; `invoice.paid`, `invoice.payment_failed`, `invoice.payment_action_required`; relevant refund/dispute events recorded and escalated until entitlement policy is approved. Handle every event as a hint to refresh authoritative objects, not as an unconditional entitlement command.

Ingress verifies and deduplicates event into inbox, acknowledges after commit, then worker processes asynchronously. Worker claims an inbox row with lease and retry count; resolves known customer/subscription/attempt mapping; rejects wrong merchant/mode, price, tenant references or inconsistent customer linkage. Orphan/ambiguous events remain quarantined with operator alert rather than choosing a tenant by email.

Out-of-order handling: serialize processing/reconciliation per family through durable worker lease. Retrieve current provider subscription and invoice facts outside DB locks; then apply under family lock with worker fencing/version check. Older workers cannot overwrite a newer applied snapshot. Event `created` ordering alone is insufficient. A canceled old subscription cannot displace a newer recognized active subscription. Multiple active provider subscriptions quarantine checkout and alert an operator; no automatic new charge or guessed winner.

Payment confirmation requires recognized subscription/customer/price and successful settled invoice evidence for the relevant access period, or an explicitly approved trial. Status active alone does not prove an initial invoice was paid under every collection method; MVP uses automatic collection with approved methods. Persist payment/period facts for specification 6 and emit a local billing-change outbox record in the same transaction. Activation is confirmed only when entitlement projection has consumed the current snapshot and established the family, not merely when event inbox state is APPLIED.

Worker polls durable inbox at least every 5 seconds; retry with exponential backoff/jitter, bounded to a configured maximum, then alert/quarantine. Scheduler reconciles known nonterminal subscriptions at least hourly and pending checkout every minute, plus owner-triggered status refresh with rate limit. Reconciliation workers use the same fencing/application path as webhooks; restart does not lose pending work. Do not rely on a single in-memory Fastify timer in a multi-instance deployment.

Stripe describes asynchronous subscription lifecycle notification and signature requirements in [subscription webhooks](https://docs.stripe.com/billing/subscriptions/webhooks) and [webhook endpoint guidance](https://docs.stripe.com/webhooks). The lease, fencing and inbox design above is the proposed application implementation.

## Billing frontend and portal

Add owner `/subscribe`, `/billing`, `/billing/return`; lazy-load only owner APIs after role resolution. Plan screen shows approved total recurring basis, tax disclosure, included features/limits and terms before purchase. Payment pending, canceled, failure, active, scheduled cancellation and unavailable states have clear actions. Existing member/manager UI never sees invoices/payment details.

Portal handles payment method/invoice/cancellation actions using the configured customer. Returning from portal refreshes authoritative subscription state; query string does not update billing. Cancellation configuration must match period-end proposal; immediate cancellation, refund adjustments and plan changes are disabled unless separately approved. Provider capabilities must be verified against [Stripe Customer Portal documentation](https://docs.stripe.com/customer-management) for the installed account/configuration.

## Implementation tasks and migration

1. Add billing module routes/schemas/controller/service/repository, server SDK/config validation, secret redaction and raw-body webhook handling.
2. Append billing tables/indexes/RLS denial/grants; leave existing families without customer/subscription until explicit purchase. Do not create provider customers in migration.
3. Implement customer/checkout durable operations, idempotency, retries and safe owner DTOs.
4. Implement inbox worker, snapshot reconciliation/fencing, outbox seam and deployment worker entrypoint/runbook.
5. Add typed billing API and owner pages/navigation; connect onboarding without granting entitlement from redirect.
6. Configure test merchant, product/price, portal, webhook endpoint/events and approved methods. Validate pinned version shapes rather than assuming current-period fields exist at a particular nesting level.

## Validation and acceptance

- Owner-only endpoint matrix, forged tenant/customer/price IDs and manager access denied; foreign checkout attempts 404.
- Concurrent checkout, customer creation and response timeouts with restart; one intended active subscription, durable UNKNOWN recovery, key/body mismatch rejected.
- Exact raw-body signature tests; invalid/expired signature, modified body, wrong mode/merchant, duplicate event and DB-down acknowledgement behavior.
- Webhook order permutations, duplicate workers, expired lease, lost events/reconciliation, old canceled/new active subscription and orphan metadata cases.
- Stripe test-mode purchase, required payment action, failure, canceled/expired checkout, delayed confirmation where supported, renewal, portal update, scheduled cancellation and resubscription.
- Frontend return before webhook, lost return, portal return, refresh/relogin and backend outage; no dashboard from unconfirmed payment.
- Card/token fields absent in DB/log/UI; invoice/payment details visible only to owner.
- Payment facts and entitlement outbox contract tests with specification 6; no duplicate tenant or ledger mutations.

Use provider test fixtures/CLI and owned staging identities; no live charges. Proposed payment-to-usable-dashboard p95 60 seconds is measured end to end only once specification 6 is installed.

## Release, rollback and completion

Default CHECKOUT_ENABLED false. Roll out test/staging worker and signature validation before live account switch. Separate purchase kill switch from event ingestion: disabling new checkout must keep portal recovery, webhooks, reconciliation and financial history operating. Never delete customer/subscription references on rollback or stop processing paid-customer events.

Monitor durable inbox age (alert when >60 seconds in healthy operation), failure/quarantine count, checkout UNKNOWN age, duplicate subscription alarms, provider API errors and reconciliation drift. Manual replay accepts a known inbox ID through an operator command with authorization/audit, never an unsigned public “activate” endpoint.

Completion requires approved plan/merchant settings, provider-version and test-mode evidence, both app checks, DB concurrency tests, worker/restart runbook and specification 6 integration. Unresolved refund/dispute policies prevent live enablement, not documentation completion.

Traceability: BILL-01–10, TEN-05; AUTH-08 identity preservation; prerequisite facts for lifecycle enforcement.
