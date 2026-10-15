# Specification 05: Stripe subscriptions

Branch: `codex/stripe-subscriptions`. Based on `codex/saas-tenant-onboarding` (PR #13), which is required before this branch reaches main. This implementation supplies billing facts and recovery; specification 06 supplies entitlement enforcement and activation. Checkout remains disabled by default.

## Implemented flow

The current OWNER alone can reserve a checkout, inspect subscription/attempt state, or create a hosted portal session. Authenticated identities may read the approved public plan. Client-supplied tenant/customer/subscription/price/amount/return URLs are rejected. Existing Google and email OTP identities continue through the same membership resolution. Draft owners can reach billing without gaining product access.

Checkout reserves one durable unresolved operation per family under a family/OWNER lock. Customer and session calls happen outside database locks with stable operation keys. Stored parameters survive configuration changes and retry/restart. HTTP returns the hosted session when ready, otherwise PROCESSING and an opaque attempt ID. The worker recovers the same operation. Beyond 23 hours, it discovers existing provider objects by validated references rather than risking reuse of an expired provider idempotency key; ambiguity requires operator review. Only confirmed terminal sessions/terminated subscriptions permit another attempt. TEST/LIVE and merchant mappings are isolated.

Signed webhooks use a separate bounded raw-buffer parser outside Supabase authentication. Signature timestamp tolerance is 300 seconds in both directions; the API version, environment and any account reference must match. Acknowledgement follows the durable inbox commit. Duplicate event IDs deduplicate in PostgreSQL. Unsupported events become IGNORED. Only event/type/object/customer references are retained, never raw webhook payloads, card data, signature or payment tokens.

The separate worker processes durable inbox/account leases with monotonic fencing, capped retries and jitter. Idle polling is five seconds. Pending checkouts are scheduled each minute, other known accounts hourly; owner status reads request a rate-limited refresh (once per 30 seconds across instances). Provider latency/backlog requires sufficient worker capacity; monitor oldest pending work. Current subscription lists and invoice/payment objects are retrieved afresh. Unknown customer/session/subscription linkage, unexpected prices, missing subscriptions, multiple nonterminal subscriptions, trials and refund/dispute review conditions quarantine the account. No email-based association is performed.

Paid-through evidence requires automatic collection, a paid invoice, sufficient settled captured PaymentIntent/charge evidence, matching customer/subscription/price and a matching recurring invoice line. Active status and out-of-band/manual payment do not establish payment. Previous verified paid-through facts survive renewal failure. Historical subscriptions remain separate rows; an old cancellation cannot replace a newer active subscription.

Snapshot application and `billing_change_outbox` insertion share a transaction. Browser roles have no billing table/RPC grants. Payment return URLs, invoice facts and APPLIED inbox state do not unlock the dashboard.

## Configuration abstraction

`billing.config.ts` builds normalized non-secret commercial settings from the validated backend environment. Both root and backend `.env.example` enumerate every value. Secrets stay on the backend/worker; the frontend needs no Stripe keys.

| Environment variable | Required approved value |
| --- | --- |
| `STRIPE_MODE` | TEST (default) or deliberately configured LIVE |
| `STRIPE_SECRET_KEY` | Matching `sk_test_` / `sk_live_` secret, configured privately |
| `STRIPE_WEBHOOK_SECRET` | Signing secret for this environment's endpoint |
| `STRIPE_ACCOUNT_ID`, `STRIPE_MERCHANT_COUNTRY` | Merchant account and country, verified against the authenticated account |
| `STRIPE_PRICE_ID` | One active recurring licensed monthly price, quantity one, no tiers; amount is read from Stripe |
| `STRIPE_PORTAL_CONFIGURATION_ID` | Active environment-matching portal with payment-method/invoice management, period-end cancellation and subscription updates disabled |
| `PUBLIC_APP_URL` | Approved frontend origin; HTTPS, with localhost HTTP allowed only outside production |
| `BILLING_PLAN_TITLE`, `BILLING_PLAN_FEATURES` | Approved title and pipe-separated feature descriptions |
| `BILLING_MEMBER_LIMIT` | Explicit positive integer or `unlimited`; enforcement belongs to specification 06 |
| `BILLING_CURRENCY` | Approved lowercase Stripe currency; must match the price |
| `BILLING_TAX_BEHAVIOR` | `inclusive` or `exclusive`, matching the price |
| `BILLING_AUTOMATIC_TAX` | Explicit `true`/`false` approved tax handling |
| `BILLING_PAYMENT_METHODS` | `card`; additional asynchronous methods require separate approval/implementation |
| `BILLING_TERMS_URL`, `BILLING_PRIVACY_URL`, `BILLING_POLICY_URL` | Approved HTTPS terms, privacy, cancellation/refund policy URLs; portal legal links must match |
| `BILLING_TAX_DISCLOSURE` | Approved human-readable tax disclosure |
| `BILLING_APPROVAL_REFERENCE` | Reference to the approved commercial configuration |
| `BILLING_EVENT_RETENTION_DAYS` | Approved 1–365 day operational-reference retention; required before enabling checkout |
| `BILLING_MAX_RETRIES` | Bounded automatic retry count (default 10); exhausted work is quarantined/FAILED |
| `BILLING_AVAILABLE`, `CHECKOUT_ENABLED` | Both false by default; checkout requires both and the complete approved configuration |

No price, currency, member cap, trial, discount or legal policy is invented. Startup rejects incomplete enablement, unsafe origins, mode/key mismatch and unsupported methods. Plan validation checks provider price/product, account and portal policy before purchase. The UI displays the recurring amount, tax disclosure, features/limit and legal links; currency formatting includes Stripe's ISK/UGX amount exceptions.

## Migration and deployment

Apply `010_stripe_billing.sql` **once after 001–009**, using the deployment migration ledger and a staging rehearsal/backup. It creates billing tables, constraints, private RPCs, durable schedule/leases, audit and entitlement seam. It creates no provider customers, subscriptions, charges or ledger mutations. This work did not apply migrations to hosted production or call an owned merchant account.

Build backend/frontend normally. Run a separate supervised worker using:

```sh
npm run build --prefix backend
npm run worker --prefix backend
```

For development: `npm run worker:dev --prefix backend`. Docker Compose has an explicit worker profile sharing backend configuration:

```sh
docker compose --profile billing up --build
```

Deploy web and worker with the same merchant/mode configuration. Multiple worker replicas are supported by database leases. Configure endpoint `/api/v1/billing/webhooks/stripe` for **snapshot events**, API version **2026-09-30.endive**, using the event allowlist in `billing.webhook.ts`. SDK is pinned to **stripe 23.0.0**. The pinned SDK exposes subscription periods on subscription items and Checkout's explicit `allowed_payment_method_types` card filter; tests use these installed types/shapes.

No checkout enabling or live charging is part of this implementation. First configure an owned TEST merchant, approved product/price/portal and private secrets. Verify product tax behavior, merchant terms/privacy, automatic collection and disabled plan changes/immediate cancellation/trials. Exercise purchase, authentication-required card, decline, abandoned/expired session, webhook before/after return, renewal failure/recovery, portal payment updates, scheduled cancellation and resubscription with Stripe test mode/CLI. Kill/restart the worker during provider response loss and verify the same session/customer are recovered. Verify actual response/event shapes against the pinned version. Record evidence before enabling staged purchase and before any LIVE rollout.

## Specification 06 integration contract

Each `billing_change_outbox` row identifies family, account and monotonic snapshot version. Read recognized subscriptions at that account/version and preserve revoked membership restrictions independently. Quarantined accounts publish no usable new outbox snapshot. In one family-first transaction, specification 06 must project entitlement, establish an eligible SELF_SERVICE family, consume the outbox row and upsert `billing_activation_receipts(account_id,snapshot_version,established_at)`. It must reject stale versions/merchant/mode and keep history.

Attempt activation is CONFIRMED only with a receipt for the current account version, an established family and no account quarantine. No receipt is written by specification 05. Specification 06 must also update `/me` and the SQL product policy; this branch retains the legacy compatibility policy and unpaid draft boundary. Until that integration exists, even a successful TEST payment stays pending rather than opening a dashboard.

## Operations and recovery

Monitor pending inbox age (alert above 60 seconds when healthy), FAILED inbox rows, quarantined accounts, UNKNOWN attempt age, account reconciliation lag and provider error rates. Alert from these durable rows, not only process logs:

```sql
select state, count(*), min(received_at) from billing_events group by state;
select id, family_id, alert, failures, reconcile_at from billing_accounts
where quarantined or reconcile_at < now() - interval '1 hour';
select id, state, created_at from billing_checkout_attempts where state='UNKNOWN';
```

Operator commands require backend service credentials and access to the supervised worker host. They are not public HTTP routes:

```sh
# Replay a known event after investigating its failure; audit is recorded.
npm run worker --prefix backend -- --replay INBOX_UUID
# Release a quarantined account only after investigating provider records,
# duplicate subscriptions and the exact incident; invalidates old worker fences.
npm run worker --prefix backend -- --release-account ACCOUNT_UUID REVIEWED_INCIDENT_REFERENCE
```

Never resolve duplicate charges by choosing a tenant by email, deleting a membership, minting a fresh operation key, or directly marking a family paid. Unresolved refunds/disputes remain operator review until entitlement policy is approved. Retention clears customer/object references from APPLIED/IGNORED inbox rows after the configured interval; ID/type/environment tombstones remain for durable deduplication. Financial/audit retention requires the separate approved accounting policy.

Disable `CHECKOUT_ENABLED` to stop new session creation while keeping portal recovery, ingress, reconciliation and history running. Existing hosted sessions remain valid until Stripe expires them; a total purchase halt also requires reviewing/expiring open provider sessions. Preserve tables and provider references on rollback. Do not revert to a backend that permits draft product access. The worker must remain deployed for paid-customer events regardless of the purchase switch.

## Validation and remaining acceptance

Verified: **389 backend tests in 43 suites with disposable PostgreSQL**, **163 frontend tests in 18 suites**, both builds/typechecks and changed frontend lint. Docker Compose configuration validates; required deployment credentials remain unset in this workspace. The frontend retains the existing bundle-size warning.

Automated checks cover PostgreSQL concurrent reservation, request replay/mismatch, browser denial, cross-family attempts, terminal-session/fresh-reconciliation rules, fenced worker restart, durable dedupe/replay, old/new subscriptions, missing/multiple subscription quarantine, paid-through preservation, outbox/receipt gating and migration rehearsal. SDK-based signature tests cover exact bytes, invalid/expired/future signatures, malformed envelopes, wrong mode/merchant/version, unsupported events, duplicate ingress and storage failure. Provider fixtures cover stable operation keys, timeout/UNKNOWN recovery, expired-key discovery, linkage rejection and settled payment evidence. Owner endpoint and frontend tests cover strict commercial input, role/privacy gates, unavailable settings, canceled/pending/confirmed return, stable retry keys, ignored late responses after identity/context changes, portal recovery and outage rechecks.

Specification 06 integration is implemented in migration 011; its `applied_version` receipt separates committed snapshots from worker lease versions. See the [entitlement rollout guide](06-subscription-entitlements-rollout.md). Owned Stripe-account/CLI end-to-end evidence remains release acceptance work. Provider fixture tests do not substitute for an actual TEST account transaction, and no such transaction is claimed here.

Primary references: [Stripe SDK v23](https://github.com/stripe/stripe-node/tree/v23.0.0), [idempotency retention](https://docs.stripe.com/api/idempotent_requests), [signed raw webhooks](https://docs.stripe.com/webhooks), [hosted Checkout](https://docs.stripe.com/api/checkout/sessions/create), [Customer Portal](https://docs.stripe.com/customer-management), [currency minor-unit exceptions](https://docs.stripe.com/currencies).
