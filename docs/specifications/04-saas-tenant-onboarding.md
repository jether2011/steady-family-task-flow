# Specification 4: Explicit SaaS tenant onboarding

Date: 2026-10-11 · Status: Implemented; rollout disabled pending specifications 5/6 · Branch: `codex/saas-tenant-onboarding`

Depends on [membership foundation](01-tenant-membership-roles.md); email login improves signup but is not required to implement this branch. Source: [PRD](../product/PRD-family-access-and-saas.md); [shared conventions](README.md).

## Outcome and boundaries

An authenticated prospective owner explicitly creates one isolated family, completes its profile and resumes a recoverable unpaid draft. Login itself never creates a tenant. Paid activation is performed by specifications 5 and 6. Existing configured families retain their owner and history.

No multi-family accounts, owner transfer, draft deletion, automatic trials or invented price. A family is a tenant in the existing shared database. The branch delivers the onboarding boundary with paid signup hidden until checkout and enforcement are ready.

## Family lifecycle and persisted state

Add to `families`:

- `lifecycle`: DRAFT or ESTABLISHED; existing configured families become ESTABLISHED, incomplete existing families DRAFT with legacy eligibility retained separately.
- `profile_completed_at`: nullable instant; backfill only when existing relationship and responsible name satisfy current configured-family rule.
- `established_at`: nullable instant; existing established families backfilled, new families only set on confirmed entitlement activation.
- `creation_source`: LEGACY or SELF_SERVICE; server-owned and immutable.

Subscription restriction is not a lifecycle value. An ESTABLISHED canceled family remains established and retains records; it does not become a new DRAFT. Billing entitlement, defined in specification 6, controls its ongoing capabilities.

Add `tenant_creation_requests` with app user, UUID request key, request hash, resulting family ID, timestamps; unique `(app_user_id,request_key)`. Transactionally create the legacy responsible-user profile, family and OWNER membership together. Existing responsible row uniqueness and membership app-user uniqueness remain hard one-tenant constraints. Do not delete a revoked membership to allow new tenant creation.

Eligibility checks provider-confirmed identity plus current membership/email reservations. Use app-user row lock then email reservation lock/constraint to serialize first membership claim and family creation; family transactions follow the family-first convention after creation. A concurrent manager provision matching this identity must conflict deterministically through normalized email uniqueness, not produce two tenants. An existing owner can resume its draft; a current/revoked member cannot create another family through this endpoint.

## REST contract

All paths under `/api/v1`; strict schemas; stable subject/app user from authentication, never body. `Idempotency-Key` is a UUID generated once per intended create action; CORS explicitly permits this header.

| Method/path | Request | Success |
| --- | --- | --- |
| POST `/families` | `{name, responsible_name, relationship}` + Idempotency-Key | 201 `{family, lifecycle:'DRAFT', profileCompleted:true, nextAction:'SUBSCRIBE'}`; replay returns 200 with same result/current state |
| GET `/family/onboarding` | No body | `{family, lifecycle, profileCompleted, nextAction:'COMPLETE_PROFILE'|'SUBSCRIBE'|'OPEN_DASHBOARD', billingAvailable:boolean}`; OWNER only |
| PATCH `/family/onboarding` | `{name?,responsible_name?,relationship?}` | 200 current onboarding result; OWNER only; atomic owner/family profile update |
| GET `/me` | Existing union | Uses lifecycle, profile completion and entitlement policy for routing |

Trim required names, require 1–120 characters, relationship enum FATHER/MOTHER/GUARDIAN/OTHER. Empty optional name patches are invalid. Avatar remains editable via existing settings after establishment. Never accept lifecycle, owner ID, role, family ID, paid state, source or points.

Idempotency mismatch returns `409 IDEMPOTENCY_CONFLICT`. Already associated different tenant returns `409 TENANT_ASSOCIATION_CONFLICT` without family disclosure. Same owner's existing family is returned as a resume response, not a duplicate insert. Auth absent 401; unverified identity 403 EMAIL_VERIFICATION_REQUIRED; invalid payload 422; disabled new signup 503 SIGNUP_UNAVAILABLE. Transient failure rolls back every ownership row and permits the same request key to retry.

Keep `PATCH /family` as an established household settings endpoint. Additional managers may edit established household fields under specification 1; draft onboarding is OWNER only. Update the frontend misleading `useCreateFamily` alias: explicit creation calls new POST; onboarding edits call its PATCH, not generic family creation.

## `/me` routing and capability boundary

| Identity/family condition | State and destination |
| --- | --- |
| No membership | NO_ACCESS; `/no-access` with Create a family action if signup enabled |
| Revoked membership | REVOKED; `/access-revoked`, no creation action |
| Owner, incomplete profile | ONBOARDING_REQUIRED; `/onboarding` |
| Non-owner, incomplete draft | ONBOARDING_REQUIRED; waiting-for-owner view, no editing |
| Self-service draft, complete profile, no entitlement | PAYMENT_REQUIRED; OWNER `/subscribe`; non-owner payment-required notice, no portal |
| Established entitled family | READY; role dashboard |
| Established family later restricted | READY with restricted capabilities supplied by specification 6; owner has billing recovery |

Until specification 6 exists, do not infer paid access from lifecycle, return URL or frontend state. Self-service drafts remain blocked. LEGACY existing-family compatibility is enabled only through an explicit temporary server policy; it never applies to SELF_SERVICE drafts. Avoid redirect loops when billing is not yet available: show “Subscriptions are not available yet” rather than create an active tenant or repeatedly redirect.

Database/browser policies must prohibit ordinary reads/writes to self-service DRAFT product data, even if an owner JWT is valid. Only owner profile/onboarding and billing metadata via backend are available. Draft members cannot be provisioned via bypassed management endpoints. Lifecycle is evaluated inside authorization helpers, not UI alone.

## Frontend journey

1. NO_ACCESS screen explains no family access and shows Create a family when eligible and signup flag allows it.
2. Owner provides family name, own display name and relationship. Label “Relationship to the family” rather than implying descriptive relationship is access role.
3. Submit once with stable request key; maintain key through network retry. Refresh/relogin resumes the server draft through `/me` and onboarding GET.
4. Completed profile leads to `/subscribe`; checkout UI is a placeholder until specification 5 ships. Never open manager dashboard on profile submission alone.
5. Successful activation returns the same family and owner context; add-member/task empty states are the existing workflows.

Use auth identity display-name prefill only as optional editable text. Form/loading/error/disabled/retry states are accessible and mobile-compatible. Store no auth tokens or payment state in draft form persistence. A route deep link cannot bypass the lifecycle gate. Returning from an unfinished signup does not prompt unnecessary new family creation.

## Implementation tasks and migration

1. Add lifecycle/source/completion columns and request-idempotency table; backfill by actual owner/profile data and record counts.
2. Build locked create/resume/profile-update functions and exact response schemas; enforce verified subject and all one-tenant reservations.
3. Extend `/me`, context capabilities, API/RLS draft checks and OpenAPI; update typed frontend family APIs.
4. Refactor Onboarding, NO_ACCESS and Layout routing, request-key retry handling and explicit profile completion.
5. Add server flags `SELF_SERVICE_SIGNUP_ENABLED` and `BILLING_AVAILABLE`; default both false until later dependencies pass release acceptance. Frontend flags only control presentation.
6. Preserve existing family IDs and profile data; do not touch points/history or apply charges during migration.

## Validation and acceptance

- Fresh authenticated owner creates exactly one DRAFT with OWNER membership and owner profile; first login alone creates none.
- Duplicate clicks, same/different idempotency keys, same-key different body, concurrent membership claim and create, and network interruption maintain one family and consistent associations.
- Ordinary/revoked members cannot create, resume/edit owner drafts, access draft product endpoints or assign themselves OWNER.
- Refresh/relogin and checkout cancellation retain the same draft, profile and request association.
- Existing configured family remains READY under temporary legacy policy; incomplete legacy family resumes its original profile without checkout enforced prematurely.
- Browser direct SELECT/write and privileged RPC invocation cannot bypass draft limits.
- Invalid relationship/name/server-owned fields rejected; profile update is atomic across family/owner.
- React routing verifies NO_ACCESS, owner onboarding, member waiting screen, subscribe unavailable and dashboard activation without loops.
- Database migrations preserve tenant/member/ledger identifiers and roll back partial creation on forced failure.

## Release, rollback and completion

Ship lifecycle schema and disabled UI first. Enable self-service only after specifications 5/6 and approved plan/terms exist. Kill switch stops new draft creation; keep existing draft resume and owner payment recovery available where billing remains enabled. Rollback never restores automatic `/me` family creation or treats every DRAFT as paid.

Monitor create conflict rate, partial creation alarms, draft resume success and onboarding-to-checkout funnel. Completion requires real DB concurrency/constraint tests, frontend onboarding tests, both builds/typechecks, migration rehearsal and reviewed single-tenant policy. Paid signup remains deliberately disabled until its commercial dependencies are resolved.

Traceability: TEN-01–06, AUTH-07/09; BILL-03/04 foundation. Subscription activation is owned by specifications 5/6.

Implementation and release instructions: [specification 04 rollout guide](../implementation/04-tenant-onboarding-rollout.md).
