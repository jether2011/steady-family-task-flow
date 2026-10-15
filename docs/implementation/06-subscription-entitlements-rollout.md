# Subscription entitlements rollout

Implemented on `codex/subscription-entitlements`, based on updated main `7642d93`. Specification: [06](../specifications/06-subscription-entitlements.md).

## Access and payment recovery

Migration `011_subscription_entitlements.sql` is the access authority. Active membership and role checks precede entitlement checks. Every product write rechecks access using the database clock after acquiring family and membership locks. Established expired families retain authorized history, boards and standings in read-only mode. Draft families cannot access product data. Owners retain onboarding metadata and billing recovery; a failed entitlement projection cannot prevent an authenticated owner from opening the billing portal. Revocation remains available through a separate versioned, audited operation that cannot grant access or edit a profile.

Recognized customer, Checkout session, subscription, merchant, mode, price and settled coverage are required for paid activation. Subscription status alone cannot activate a draft. Projection, lifecycle establishment, immutable entitlement history, activation receipt and outbox acknowledgement commit together. `billing_accounts.applied_version` identifies the committed provider snapshot independently of the worker lease `version`; polling does not invalidate a committed receipt.

Renewal grace uses the first failure in an episode. Provider tolerance uses a fixed cutoff from previously verified coverage. Repeated events, polling, restart and policy publication cannot renew those windows. Cancellation, terminal status and expired grace cannot gain outage tolerance. Converted legacy families never regain migration access. Authorization evaluates deadlines immediately even if the projection worker is delayed. Effective entitlement versions separate browser caches at deadline transitions.

## Configuration and deployment

All commercial values remain environment configuration; no secret or approved price is embedded. Consult the root and backend `.env.example` for the complete Stripe and entitlement settings. New switches default off. Grace and provider tolerance have no production numeric defaults; the test fixture values are not approved commercial policy.

To publish an approved policy, configure `ENTITLEMENT_POLICY_VERSION`, `ENTITLEMENT_POLICY_APPROVAL`, `RENEWAL_GRACE_DAYS`, `PROVIDER_OUTAGE_TOLERANCE_HOURS`, `ENTITLEMENT_EXCEPTION_POLICY=RESTRICT`, explicit `BILLING_MEMBER_LIMIT`, and the existing Stripe merchant, mode and price settings. Set `LEGACY_ENTITLEMENT_DEADLINE` before enforcement. `ENTITLEMENT_ENFORCEMENT_ENABLED` and `ENTITLEMENT_TRIALS_ENABLED` remain explicit switches. Checkout also requires a fully configured published policy. Changing a published policy requires a new version and review reference; versions are immutable.

Apply migrations 001–011 in numeric order, then deploy the backend and supervised billing worker, and then the frontend. Preserve billing tables, application IDs and accounting history. The migration backfills eligible legacy access without changing ledger rows; incomplete profiles still require onboarding. Run the existing billing worker entry point (`npm run worker --prefix backend`); it publishes policy and processes both billing and entitlement queues. Docker Compose supplies the same policy environment to API and worker.

Before a production rollout, approve and communicate grace, cancellation, legacy deadline, trial, exception and retention policies. Rehearse on a database copy, reconcile existing billing accounts and verify owners can recover payment. Complete owned Stripe TEST-account purchase, webhook replay, renewal failure, cancellation, portal and restoration acceptance before enabling real checkout. This implementation does not claim hosted deployment or a live/test provider transaction.

## Cohorts, monitoring and bounded rollback

Activate a reviewed legacy cohort through the privileged worker command:

```sh
npm run worker --prefix backend -- --entitlement-cohort FAMILY_UUID enforce REVIEW_REFERENCE
npm run worker --prefix backend -- --entitlement-exception FAMILY_UUID EXPLICIT_ISO_EXPIRY REVIEW_REFERENCE
```

Exceptions apply only to established families, expire explicitly and are audited. The 24-hour technical ceiling is a safety bound, not a default commercial policy. A cohort cannot be downgraded; its first enforced legacy deadline stays pinned. Disabling the global flag does not remove activated restrictions or restore indefinite legacy access. Disable checkout to stop new purchase creation while retaining reconciliation, read-only history and portal recovery. Do not roll back the schema or deploy older unrestricted write paths.

Monitor the worker heartbeat, overdue jobs, retries, billing quarantine, unknown statuses and reconciliation lag:

```sql
select * from deployment_worker_heartbeats;
select family_id, due_at, attempts, safe_error from entitlement_jobs
where due_at < clock_timestamp() - interval '1 minute';
select id, family_id, alert from billing_accounts where quarantined or alert is not null;
```

Investigate the immutable `entitlement_events` and billing audit/outbox before repair. Never mark a family paid manually or extend timestamps to hide an incident. Restore the worker or fix recognition facts and retry the durable job. Missing projections fail closed for product access while owner billing recovery remains available.

## Validation

Automated verification includes database migration preservation, browser RLS, clock-boundary and concurrent-write authorization, ledger integrity, atomic activation rollback, stale leases, fixed grace/outage cutoffs, legacy conversion, bounded exceptions, narrow revocation, policy publication and payment linkage. HTTP and frontend tests cover role privacy, read-only views, unavailable-projection recovery and entitlement cache changes. Verified: 445 backend tests across 46 suites against disposable PostgreSQL, 181 frontend tests across 22 suites, both typechecks and builds, and changed frontend lint. The frontend build retains the existing bundle-size warning. Provider fixtures do not replace owned Stripe-account acceptance.
