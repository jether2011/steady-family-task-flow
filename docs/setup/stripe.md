# Stripe and subscription configuration

Configure an owned TEST environment first. The implementation supports one monthly, licensed, quantity-one plan with automatic card collection, hosted Checkout and the hosted customer portal. Plan changes, arbitrary client prices and additional payment methods are not implemented. The frontend needs no Stripe key.

## 1. Prepare the approved commercial settings

Record the merchant, country, currency, monthly amount, tax behavior, plan title/features, member cap (or explicit `unlimited`), legal URLs, cancellation/refund policy and operational reference retention. Set these through the [environment reference](environment.md); do not edit source constants to supply a price or policy. The amount is read from the configured Stripe Price, not a `BILLING_PRICE` variable.

Prepare a separately versioned entitlement decision: renewal grace days, provider-outage tolerance hours, trial enablement, legacy deadline and exception handling. These durations have no runtime numeric defaults. Approval-reference variables identify your reviewed configuration; they do not approve a business decision automatically.

## 2. Create the TEST product and price

1. In the intended Stripe TEST environment, create an active product and recurring **monthly** price with licensed usage, no tiers and quantity one. Choose the approved amount/currency and explicit inclusive or exclusive tax behavior.
2. Set `STRIPE_MODE=TEST`, `STRIPE_SECRET_KEY` privately to the matching `sk_test_…`, `STRIPE_ACCOUNT_ID` to the merchant account and `STRIPE_MERCHANT_COUNTRY` to its country.
3. Set `STRIPE_PRICE_ID` to the TEST `price_…`, and match `BILLING_CURRENCY` and `BILLING_TAX_BEHAVIOR` to that Price. Configure `BILLING_AUTOMATIC_TAX=true` or `false` explicitly; if true, complete the applicable Stripe Tax configuration for your merchant.
4. Supply `BILLING_PLAN_TITLE`, pipe-separated `BILLING_PLAN_FEATURES`, and `BILLING_MEMBER_LIMIT` as a positive integer or `unlimited`. Set `BILLING_PAYMENT_METHODS=card`.
5. Set `PUBLIC_APP_URL` to the frontend origin, plus approved `BILLING_TERMS_URL`, `BILLING_PRIVACY_URL`, `BILLING_POLICY_URL`, `BILLING_TAX_DISCLOSURE`, `BILLING_APPROVAL_REFERENCE` and `BILLING_EVENT_RETENTION_DAYS` (1–365).

Use HTTPS URLs without credentials/query/fragment. `PUBLIC_APP_URL` must have no non-root path. Localhost HTTP is allowed only when backend `NODE_ENV` is not production; Compose uses production mode.

## 3. Configure the customer portal

Create an active portal configuration in the same Stripe environment. Enable payment-method updates and invoice history. Enable subscription cancellation **at period end**; disable subscription updates/plan changes. Set portal terms/privacy URLs to the exact configured application values, and put the resulting `bpc_…` into `STRIPE_PORTAL_CONFIGURATION_ID`. The backend validates these settings before purchase. See [Stripe portal configuration](https://docs.stripe.com/api/customer_portal/configurations/create).

Keep trials disabled for the initial rollout unless explicitly approved and configured. The entitlement trial switch recognizes supported provider trial facts; it is not a UI for creating a trial offer.

## 4. Configure signed webhooks

1. Expose `POST https://API_ORIGIN/api/v1/billing/webhooks/stripe` publicly over HTTPS. It uses Stripe signature verification rather than a Supabase bearer token. Preserve the raw JSON request body through proxies.
2. Configure **snapshot events** with the app-pinned API version **2026-09-30.endive** (Stripe SDK **23.0.0**). The endpoint rejects a version, mode or account mismatch. If the pinned version is unavailable in your provider setup, resolve compatibility and test it before enablement; changing documentation alone cannot upgrade the integration.
3. Subscribe to the following exact allowlist from `backend/src/modules/billing/billing.webhook.ts`:

   ```text
   checkout.session.completed
   checkout.session.expired
   checkout.session.async_payment_succeeded
   checkout.session.async_payment_failed
   customer.subscription.created
   customer.subscription.updated
   customer.subscription.deleted
   invoice.paid
   invoice.payment_failed
   invoice.payment_action_required
   charge.refunded
   charge.dispute.created
   charge.dispute.updated
   charge.dispute.closed
   refund.created
   refund.updated
   refund.failed
   ```

4. Configure the endpoint's signing secret privately as `STRIPE_WEBHOOK_SECRET` on API/worker. Acknowledgement means durable inbox storage, not paid activation.
5. For native local development, forward TEST events with the Stripe CLI:

   ```sh
   stripe login
   stripe listen --forward-to localhost:8080/api/v1/billing/webhooks/stripe
   ```

   Use the listener's `whsec_…` for local API verification and restart the API after setting it. It differs from the deployed endpoint's secret. Confirm forwarded events use the pinned API version. See the [official CLI listen documentation](https://github.com/stripe/stripe-cli/wiki/listen-command). CLI fixture events alone do not supply your tenant's customer/session linkage or prove activation; perform an application Checkout purchase too.

## 5. Publish entitlement policy and run the worker

With migrations 001–011 applied, configure API and worker identically:

- `ENTITLEMENT_POLICY_VERSION`: new immutable version identifier.
- `ENTITLEMENT_POLICY_APPROVAL`: reviewed policy reference.
- `RENEWAL_GRACE_DAYS`: approved integer 0–90.
- `PROVIDER_OUTAGE_TOLERANCE_HOURS`: approved integer 0–168.
- `ENTITLEMENT_EXCEPTION_POLICY=RESTRICT`.
- Matching merchant/mode/price and explicit member limit.
- `ENTITLEMENT_TRIALS_ENABLED=false` unless approved.
- `ENTITLEMENT_ENFORCEMENT_ENABLED`: deliberate rollout switch; true also requires an ISO timestamp with timezone in `LEGACY_ENTITLEMENT_DEADLINE`.

Publish by starting the separate supervised worker, initially with checkout closed:

```sh
npm run build --prefix backend
npm run worker --prefix backend
# Development alternative: npm run worker:dev --prefix backend
# Compose alternative: docker compose --profile billing up -d --build
```

The worker requires the Stripe account and secret even for entitlement administration. It publishes the complete configured policy before processing inbox, reconciliation and projection jobs. Changing the contents of an existing policy version is rejected; use a new version. Check logs and `deployment_worker_heartbeats` to confirm processing. The API alone cannot process payment activation.

The global enforcement flag is not a switch to make SELF_SERVICE drafts free: those tenants always need recognized entitlement. Existing legacy families follow explicit cohorts and pinned deadlines. See [bounded rollout](../implementation/06-subscription-entitlements-rollout.md).

## 6. Open staged purchase

Set `BILLING_AVAILABLE=true` and, after policy publication and provider validation, `CHECKOUT_ENABLED=true`; restart API and worker. Enable `SELF_SERVICE_SIGNUP_ENABLED=true` for the controlled signup test. Keep membership/member-view flags enabled after their acceptance.

Sign in as an eligible test owner, create the tenant explicitly, complete the profile and subscribe through the application. Confirm plan amount, currency, tax disclosure, cap and legal links before entering Stripe TEST card details. On return, the UI waits for confirmed activation. Verify the same tenant becomes usable only after payment evidence, entitlement projection and receipt commit. Test cards and test clocks must be used only in the owned TEST environment.

Then exercise decline, authentication challenge, abandonment/expiry, duplicate delivery, webhook before/after browser return, worker restart, renewal failure/recovery, portal payment updates, scheduled cancellation, expiry/read-only mode and resubscription. Check Member privacy and revoked access throughout. Record evidence; existing automated fixture results are not owned-account acceptance.

## 7. Monitor and recover

Use the private database/operations host, not browser table access:

```sql
select name, seen_at from deployment_worker_heartbeats;
select state, count(*), min(received_at) from billing_events group by state;
select family_id, due_at, attempts, safe_error from entitlement_jobs
where due_at < clock_timestamp() - interval '1 minute';
select id, family_id, alert, failures, reconcile_at from billing_accounts
where quarantined or reconcile_at < now() - interval '1 hour';
```

A paid return that remains pending usually needs reconciliation/projection, linkage review or quarantine investigation. `billing_accounts.applied_version` identifies the committed snapshot; worker `version` is a lease fence. Activation requires the matching committed receipt and effective access, not a URL, invoice status or lease number alone.

Owners can access `/billing` for portal recovery even if product entitlement resolution is unavailable; the server still verifies ownership. Missing projections restrict product access. Grace/outage windows are fixed; repeated polls never extend them. Cancellation, terminal states and expired grace cannot gain outage tolerance.

Reviewed replay/quarantine release commands and bounded cohort/exception commands are in [billing operations](../implementation/05-stripe-billing-rollout.md) and [entitlement operations](../implementation/06-subscription-entitlements-rollout.md). Do not mark a family paid or reassign a customer by email.

## 8. Production and rollback

After TEST acceptance, configure matching LIVE merchant resources, `sk_live_…`, webhook secret, price, portal and a reviewed policy version. Verify the exact deployment settings and monitoring before enabling public purchase. This guide does not authorize or perform a production payment.

To stop new sessions, disable `CHECKOUT_ENABLED` and restart API/worker while retaining reconciliation and portal configuration. Existing hosted sessions can remain valid until expired; review them separately for a total halt. Disable signup separately if needed. Preserve migrations, billing references, immutable audit and ledger history. Disabling enforcement does not downgrade activated cohorts or erase pinned deadlines; use only the explicit audited, time-bounded exception workflow.
