# Specification 04: Tenant onboarding rollout

Implemented on `codex/saas-tenant-onboarding`, based on specification 03. Billing activation remains owned by specifications 05/06.

## Behavior

Login resolves identity and membership; it never creates a household. Eligible, provider-verified identities explicitly create an unpaid family using `POST /api/v1/families` and a UUID `Idempotency-Key`. Creation of the responsible profile, family, OWNER membership and request association is one transaction. Retrying the same body/key returns the same family; changing the body under the same key returns `409 IDEMPOTENCY_CONFLICT`. New keys for the same owner resume the existing family without editing it. Members and reserved/revoked mailboxes cannot create another household.

Owners resume through `GET /family/onboarding` and update profile fields through `PATCH /family/onboarding`. Completed self-service profiles go to `/subscribe`, which explains that subscriptions are unavailable and the draft is saved. Incomplete legacy owners complete their original family through `/onboarding`. Managers and members wait for their owner. Established settings continue to use `PATCH /family`.

`/me` supplies server-derived signup eligibility, routing state and capabilities. Deep links are gated before product pages mount. A creation intent retains its UUID through transport retries; editing the submitted body starts a new intent. Refresh/relogin uses the persisted server membership, even when a previous creation response was lost. No tokens or payment state are stored in form persistence.

## Database policy and migration

Apply **009_tenant_onboarding.sql once**, after migrations 001–008, before deploying the new backend. Back up production and rehearse on a staging copy first. This implementation was tested on disposable PostgreSQL, not applied to the hosted production project.

The migration adds lifecycle/source/profile timestamps and the private `tenant_creation_requests` table. Existing households become `LEGACY`, with a separate `legacy_access_eligible=true` compatibility marker. Configured profiles become ESTABLISHED; incomplete profiles remain DRAFT. Existing family, participant, task, completion and ledger identifiers remain unchanged. Migration notices report the established/draft backfill counts. Capture these counts and the pre/post ledger counts in the deployment record:

```sql
select creation_source, lifecycle, count(*) from families group by 1,2;
select count(*), sum(points) from points_transactions;
select count(*) from task_completions;
```

The explicit temporary access policy is **profile complete AND ESTABLISHED AND LEGACY AND legacy_access_eligible**. Both SQL authorization and backend routing enforce it. It never grants access to SELF_SERVICE, even if lifecycle is changed to ESTABLISHED without a confirmed entitlement. Specification 06 must replace this policy with entitlement enforcement while deliberately retaining the approved legacy treatment.

Source and legacy eligibility are immutable through ordinary updates. Profile completion stays synchronized across onboarding and established settings; clearing a profile does not revert an established lifecycle. SQL product mutation helpers, browser RLS helpers and the member read-model wrapper all reject restricted drafts. The underlying snapshot implementation is private, including to `service_role`; the lifecycle-checked wrapper is the callable entry point. Browser roles cannot execute creation/onboarding RPCs or read request associations. Service keys remain backend-only.

## Configuration and deployment

Both server flags default to `false` and are passed through Docker Compose:

- `SELF_SERVICE_SIGNUP_ENABLED=false`: hide creation and reject new drafts with `503 SIGNUP_UNAVAILABLE`. Existing owner resume/profile updates remain available.
- `BILLING_AVAILABLE=false`: reported in onboarding metadata. This branch supplies no checkout or activation flow; setting this flag alone never grants access.

Keep both flags false in production until specifications 05/06, the plan and commercial terms pass release acceptance. For staging acceptance only, signup can be enabled to exercise draft creation. Google and email OTP continue using the same verified subject and membership resolution; no auth provider configuration changes are required by this branch.

Deploy schema, backend and frontend together in that order. Check an existing configured Google owner remains READY, an incomplete legacy owner resumes the same family, and an unassociated identity sees no signup action while the flag is false. In staging with signup enabled, create a draft, retry the request, reload/sign out/in, and verify the same family returns to the subscription notice. Direct board, member provisioning and settings requests must return `403 TENANT_ACCESS_RESTRICTED` for that draft.

## Verification and operations

Validation passed: **325 backend tests across 38 suites** with disposable PostgreSQL and **149 frontend tests across 16 suites**. Both builds/typechecks and lint for changed frontend files passed. A final targeted run also passed all 20 lifecycle database tests with administrator-seeded private draft rows. The frontend build retains its existing large-bundle warning.

Automated acceptance covers real PostgreSQL concurrency, request replay/mismatch, membership claim/provision conflicts, reserved/revoked mailboxes, forced transactional failure and retry, legacy backfill/profile completion, preserved ledger/completion IDs, browser grants/RLS and private function execution. HTTP tests cover strict input, verified identity, owner-only onboarding, product gates, OpenAPI and the CORS idempotency header. React tests cover editable prefills, retry keys, profile resume, disabled signup, deep links and subscription/member notices.

Monitor request status/code and correlation ID for creation conflicts, unavailable signup and failed resumes. Do not add tokens or identity details to operational logs. Billing/conversion monitoring and owner payment recovery are extended by the later billing specifications.

Rollback by disabling signup and retaining the lifecycle-aware backend and database gates. Do not restore automatic `/me` creation, remove ownership rows, infer payment from lifecycle or return URLs, or enable an older backend that ignores draft restrictions. Preserve drafts and idempotency records for recovery. No charges or hosted migrations are performed by this implementation.
