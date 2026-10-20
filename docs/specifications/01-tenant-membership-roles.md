# Specification 1: Tenant membership and roles

Date: 2026-10-11 · Status: Implemented and merged; provider/policy rollout remains gated · Branch: `codex/tenant-membership-roles`

Depends on current backend/frontend. Source: [PRD](../product/PRD-family-access-and-saas.md). Shared rules: [specification index](README.md).

## Outcome and scope

Replace owner-only context and automatic login bootstrap with a stable application identity and explicit family membership. Provision login access against existing member records. Enforce Owner/Manager/Member capabilities across API and Supabase; preserve owner accounts and historical data.

Includes role provisioning, claims, revocation, verified email replacement, generalized manager actor identity, owner migration and safe frontend context handling. Excludes OTP UI, tenant purchase, billing, member task writes and owner transfer. New family creation is delivered in specification 4; until then unassociated users see no-access rather than auto-bootstrap.

Proposed policies: read-only Member, globally reserved membership/email, and managers may appoint managers. These require review but are explicit implementation baselines.

## Data model and invariants

| Table/change | Required columns and constraints |
| --- | --- |
| `app_users` | UUID ID; unique non-null `auth_user_id` referencing `auth.users` with RESTRICT deletion; optional display name/avatar; timestamps. Do not use email as its primary identity. |
| `family_memberships` | UUID ID; `family_id`; nullable unique `app_user_id`; nullable `member_id`; role OWNER/MANAGER/MEMBER; status PROVISIONED/ACTIVE/REVOKED; `login_email`, unique `normalized_email`; integer `access_version` starting at 1; claimed/revoked timestamps; creator/updater app-user IDs; timestamps. |
| Membership checks | OWNER has no participant binding; MANAGER/MEMBER require a member belonging to the same family. ACTIVE requires app-user binding. At most one OWNER per family and one membership per participant; one membership per app user across tenants. Owner corresponds to legacy family owner. Enforce cross-family member integrity with composite FK or equivalent locked constraint trigger. |
| `access_audit_events` | Immutable ID, family, actor app-user, target membership, action, previous/new role/status, timestamp and request correlation ID; no codes/tokens. Server-only writes; owner/manager reads only through a scoped future operator workflow, not Member DTOs. |
| Actor expansion | Add `tasks.created_by_app_user_id`, `task_completions.completed_by_app_user_id`; backfill through legacy responsible-user auth identity, then require canonical actor for new writes. Keep old responsible-user actor columns for historical compatibility, make them nullable for additional managers. DTO exposes canonical actor; never impersonate the owner. |

`responsible_users` and `families.responsible_user_id` remain for existing owner profile composition. Do not create a responsible row or a family for an additional manager. Existing owner reference is resolved as `ownerResponsibleUserId`, never confused with the acting user. OWNER billing identity is its membership.

Email normalization: trim, validate length/format, lowercase using one shared implementation with database parity. Do not remove plus suffixes/dots. Reserve normalized addresses even when revoked to avoid mailbox reassignment leaking historic accounts; changing email frees the old reservation only after controlled replacement. Unrelated transfer/shared-mailbox workflows are out of scope. Collision reports are generic.

Block authenticated direct deletion of owner identity and replace dangerous cascading ownership foreign keys with RESTRICT behavior. Document supported operator deletion/export procedure as an explicit future operation; do not silently cascade family data from `auth.users` deletion.

## Membership transitions

| Transition | Authorized behavior |
| --- | --- |
| No-login participant → PROVISIONED | Owner/manager enables login with unique email and MEMBER default or MANAGER selection; preserve participant ID. |
| PROVISIONED → ACTIVE | `/me` claims atomically after provider-confirmed mailbox verification; bind app user once. |
| ACTIVE role change | Owner/manager changes MEMBER/MANAGER, increments version, audits; owner role immutable here. |
| PROVISIONED/ACTIVE → REVOKED | Disable login or deactivate participant; revoke, increment version, audit. Bindings and history retained. |
| REVOKED → ACTIVE/PROVISIONED | Same reserved app user reactivated when still verified; unclaimed membership returns to PROVISIONED. Reactivate participant before enabling login. |
| Login email replacement | Revoke first; store a pending replacement challenge; old person remains bound until controlled verified replacement is completed. No auto-claim of an already-linked record. |

Email replacement is for the same person, not account transfer. Add `membership_email_changes` with membership, normalized pending address, initiating manager, expected app-user ID, hashed single-use random confirmation token, expiry and completion timestamp. Initiation immediately revokes old application access. Confirmation requires the bound auth subject signed in with a provider-verified new email equal to the pending address plus valid token. Commit address/version/status atomically; audit both phases. Proposal: 24-hour challenge lifetime. If changing a verified email changes the provider subject, deny confirmation and require controlled operator identity recovery with proof of both identities; do not relink by a manager's assertion alone. Unclaimed provisioned email edits can replace the reservation without this linked-identity flow. Abandonment stays revoked; manager may cancel and re-enable the original reserved identity. No application-managed OTP is stored.

## Identity resolution and `/me`

Keep JWKS JWT verification; validate project issuer, authenticated audience, required subject and token lifetime. For a first email claim, fetch the auth user server-side through Supabase and require provider-confirmed email status. A signed `user_metadata.email` or display name is not sufficient verification evidence.

Resolution order:

1. Find/create `app_users` by verified subject, never a family. An unassociated app-user row grants no permissions.
2. If membership is already bound to this app user, use its role/status and participant active flag. A revoked binding stops resolution; never fall through to email matching.
3. If unbound, match provider-verified normalized email to exactly one PROVISIONED membership. Lock it, validate participant and subject/email reservations, bind atomically, increment version and audit. Concurrent claims either return the same binding or conflict.
4. Existing owner associations are backfilled before this resolver is enabled. Unexpected existing owner records without migration mapping fail closed and alert; no email-based reconstruction of ownership.
5. Return authorized context, NO_ACCESS, REVOKED, or a generic conflict. Claims missing verified email cannot claim membership.

`GET /api/v1/me` returns a discriminated union:

```ts
type MeResponse =
  | { state: 'NO_ACCESS' | 'REVOKED'; user: SessionUser;
      family: null; membership: null; capabilities: [] }
  | { state: 'READY' | 'ONBOARDING_REQUIRED' | 'PAYMENT_REQUIRED';
      user: SessionUser;
      family: FamilyDTO;
      membership: { id: string; role: 'OWNER' | 'MANAGER' | 'MEMBER';
        memberId: string | null; accessVersion: number };
      capabilities: string[] };
```

`SessionUser` is `{ id: appUserId, displayName: string|null, avatarUrl: string|null }`; never return Supabase admin data. Initially PAYMENT_REQUIRED is unused; specification 4 activates it. READY requires configured family. Incomplete existing families route OWNER to onboarding and others to a waiting-for-owner screen. Role-specific member dashboard is supplied by specification 3.

Request context becomes `{ authUserId, appUserId, familyId, membershipId, role, memberId, accessVersion, ownerResponsibleUserId }`, with nullable access fields for `/me`. Only narrow authorized context in family controllers. Resolve membership fresh on every request; no JWT role claim or positive access cache.

## Provisioning API

All paths use `/api/v1`; IDs are UUIDs. Requests reject unknown fields.

| Method/path | Body/result | Gate |
| --- | --- | --- |
| Existing POST `/family/members` | Existing profile fields plus optional `access: { enabled: true, email, role: 'MEMBER'|'MANAGER' }`; return existing `{member}` plus separate `access` summary | Owner/Manager; profile and provisioning commit together |
| Existing PATCH `/family/members/:id` | Existing profile/active changes only; deactivate revokes access in same transaction | Owner/Manager |
| GET `/family/members/:id/access` | `{ access: null | { membershipId, email, role, status, accessVersion } }` | Owner/Manager |
| PATCH `/family/members/:id/access` | `{ enabled, email?, role?, expectedVersion }`; return access summary | Owner/Manager; optimistic version check |
| POST `/family/members/:id/access/email-change` | `{ email, expectedVersion }`; return `{ status:'PENDING_VERIFICATION', expiresAt }`; deliver confirmation instructions through configured mail | Owner/Manager |
| POST `/me/email-change/confirm` | `{ token }`; return updated `/me` shape | Bound authenticated person with verified new mailbox |

Email replacement and restoration increment `access_version`. Stale edit: `409 ACCESS_VERSION_CONFLICT`; unique email/subject collision: `409 ACCESS_CONFLICT`; invalid fields: `422 VALIDATION`; known revoked context on family request: `403 ACCESS_REVOKED`. Error text contains no other household identity. Never accept OWNER or client actor/family IDs in provisioning.

## Capability enforcement and database access

| Route category | Owner/Manager | Member |
| --- | --- | --- |
| Family read, shared board/task read, awards catalog, leaderboard | Allowed | Safe DTOs allowed |
| Detailed roster and templates | Allowed | Denied; safe display directory via specification 3 |
| Points/completions | Any person in same family | Self only; default filter forced to own member |
| Dashboard | Management payload | Personal payload; legacy full payload denied until specification 3 ships |
| Task/template/member/award writes, complete/reopen/redeem, generate/carry-over | Allowed | Denied |
| Family profile PATCH | Allowed; manager edits owner-profile fields only as existing household settings behavior | Denied |
| Billing and draft ownership | Owner only | Denied |

Guard every route and every internal privileged service path. For mutations, recheck capability inside the transaction after acquiring family/actor locks. New managers must be recorded as canonical actors for creation/completion and audit all access changes. Completion beneficiary remains manager-selected active family member, with points derived from stored task.

RLS implementation baseline: remove existing browser INSERT/UPDATE/DELETE policies; all app mutations pass through backend-only functions or locked transactions. Member SELECT on ledger/completions is self-only. Raw `family_members` SELECT is Owner/Manager only because row policies cannot hide birth year/email; publish safe roster DTO through API. `responsible_users` is owner self-only; family projection is provided by API. `tasks` and `awards` may expose audited shared columns only; hide internal actor columns through column grants or deny raw table SELECT and use safe API projection. Templates are Owner/Manager only. Membership/auth/billing internals are denied to browser roles. Policy helpers avoid recursive membership policies, pin search_path, and use `auth.uid()` internally. Revoke PUBLIC/anon/authenticated execution of privileged existing RPC overloads; grant to service role only. Database helpers accessible to browser roles must never accept an arbitrary caller identity.

Realtime baseline: stop raw membership/ledger event subscriptions for ordinary members; use authenticated API polling every 30 seconds plus focus refresh. Owner/Manager may keep only streams whose RLS/grants pass revocation tests; if existing subscriptions remain authorized after revocation, disable them and use polling. No persistent channel may leak protected row payloads after revocation. Specification 3 owns cache/UI integration.

## Migration and implementation tasks

1. Add identities, memberships, email-change/audit structures and indexes; add/backfill canonical actors. Dry-run collision report using verified provider identities; no automatic “first match” fix.
2. Backfill owners via existing responsible-user auth subjects, reserve verified emails where available, and mark incomplete profiles ONBOARDING_REQUIRED. Fail migration on contradictory ownership or duplicated reservations.
3. Change owner deletion foreign keys and actor nullability without removing legacy data; verify historical row counts and ledger sums before/after.
4. Implement transactional provisioning/claim/revocation plus actor-aware completion/family update functions; preserve old ledger invariants.
5. Replace context/types/DTOs, route guards, database policies and grants; add OpenAPI contracts.
6. Adapt AuthContext/ProtectedRoute/Onboarding to union response and blocked states. Add access controls in `MemberModal` and management roster.
7. Update README auth/ownership descriptions and seed/test fixtures after functionality exists, not in this documentation branch.

## Test and acceptance matrix

| Test | Required assertion |
| --- | --- |
| Existing owner migration/login | Original family and ledger IDs/sums preserved; no new family |
| Unassociated verified subject `/me` | NO_ACCESS; at most app-user created, zero family/responsible rows |
| First claim concurrency | One binding; competing subject cannot replace winner |
| Metadata spoof/unverified email | Cannot claim membership or obtain manager role |
| Additional manager writes | Actual canonical actor recorded; no fake owner actor or extra family |
| Owner/Manager/Member route matrix | All operation categories enforce role, including manipulated bodies and internal calls |
| Direct REST/RPC/browser access | Cross-tenant/private SELECT denied; mutations and legacy RPC bypass denied |
| Revocation versus mutation race | Committed revocation prevents later ordered mutation; preceding committed write remains atomic |
| Email replacement | Old access revoked, wrong subject/token denied, expiry/replay denied, original cancellation/restoration safe |
| Deactivate/reactivate | Same member identity/history retained; owner immutable |
| Realtime revoked session | No subsequent protected payload; fall back to API polling when provider cannot enforce this |
| Disposable DB actor/ledger suites | Existing completion/reopen/redemption and IDOR tests remain meaningful and pass |

## Release, rollback and completion

Use backend `MEMBERSHIP_ACCESS_ENABLED` with staging-first migration and collision preflight. Once members are enabled, disabling UI provisioning must not restore legacy owner-bootstrap logic. Rollback retains role guards and data; stop new claims/provisioning, serve verified existing owners/members safely, and forward-fix schema. Old application binaries assuming every session is an owner are not safe rollback targets.

Monitor claim conflicts, no-access resolutions, revoked requests, provisioning failures and canonical actor omissions; correlate via request IDs, never emails/tokens in metrics. Completion requires database tests, frontend resolution tests, OpenAPI updates, migration rehearsal, and reviewed proposed access policies.

Traceability: AUTH-04–09, MEM-01–08, TEN-02–04; foundation for VIEW-06/08 and BILL-02. Price/Stripe behavior and member view details belong to later specifications.
