# Specification 01: membership access implementation

Branch: `codex/tenant-membership-roles`. Scope: [specification 01](../specifications/01-tenant-membership-roles.md). Email OTP login, member dashboards, tenant checkout, Stripe subscriptions and billing enforcement remain in specifications 02–06.

## Behavior

`GET /api/v1/me` resolves provider-verified identity into an existing membership. It returns NO_ACCESS, REVOKED, READY or ONBOARDING_REQUIRED without creating a family or responsible user. Role is independent of participant type. Existing owners retain their family; additional managers have their own canonical task/completion actor. Members cannot enter management routes; the merged specification 03 supplies their personal dashboard and authorized read views.

Owner/Manager can provision optional login email and MEMBER/MANAGER role during participant creation, or edit/revoke access separately. Existing claimed mailbox replacement revokes access immediately and issues a hashed, expiring, subject-bound challenge. The person must sign into the same account and complete Supabase mailbox verification before confirming. A delivery failure leaves access revoked; reload the access version and retry. Restoring the old mailbox cancels pending replacement and requires provider verification of that reserved mailbox.

Every API request resolves current membership; privileged writes recheck after locking the family in the database. Browser mutations and legacy RPC execution are revoked. Personal ledger/completion reads are self-only; private roster/templates and actor fields are protected. Raw realtime subscriptions are replaced with authorized API polling every 30 seconds and on focus.

## Migration rehearsal and rollout

1. Take a database backup and record counts for families, responsible_users, family_members, tasks, task_completions and points_transactions; record `sum(points)` grouped by family/member.
2. Review existing owner/auth associations. Find duplicate confirmed provider mailboxes before applying migration 007:
   ```sql
   select lower(btrim(a.email)) as mailbox, count(*)
   from families f
   join responsible_users r on r.id=f.responsible_user_id
   join auth.users a on a.id=r.auth_user_id
   where a.email_confirmed_at is not null and a.email is not null
   group by lower(btrim(a.email)) having count(*) > 1;
   ```
   Resolve contradictions explicitly. Migration 007 runs in one transaction and aborts on duplicate reservations or missing canonical actors; it never selects a winning household.
3. Apply migrations 001–006 as appropriate, then apply 007 once using a migration ledger. Keep `MEMBERSHIP_ACCESS_ENABLED=false` during rehearsal. Deploy compatible backend and frontend together; old binaries are not compatible with the new access model.
4. Recheck recorded counts and ledger totals. Verify each existing family has exactly one ACTIVE OWNER and every task/completion has a canonical actor. Rehearse existing-owner login, unknown-account NO_ACCESS, additional manager attribution, member denial, and revoke followed by attempted write.
5. Set `MEMBERSHIP_ACCESS_ENABLED=true` after staging verification. This flag gates new claims/provisioning. Turning it off does not remove guards, undo revoked access, or restore automatic family creation.
6. Configure Supabase OAuth redirect allowlist for `/access-email-confirm` as well as normal sign-in URLs. For mailbox replacement configure `PUBLIC_APP_URL`, HTTPS `ACCESS_EMAIL_DELIVERY_URL`, and server-only `ACCESS_EMAIL_DELIVERY_TOKEN`.

The delivery endpoint receives authenticated JSON POST `{to, template: 'membership-email-change', confirmationUrl, expiresAt}`. Send the confirmation instructions to `to`; return a successful HTTP status only when accepted for delivery. Do not log bearer credentials or confirmation links. Requests time out after ten seconds and redirects are rejected. Ordinary access provisioning does not require this adapter.

## Verification

Backend unit/API suites use mocked provider/database boundaries. The membership integration suite applies 001–006, seeds historical owners/tasks, then applies 007 and tests backfill, role claims, conflict reservations, actor attribution, isolation, browser grants/RLS, concurrent claims, ordered revocation and email replacement. The migration/seed suite applies all seven migrations to an empty database and seeds twice. Existing ledger regression suites exercise their original 001–006 fixture baseline; membership integration additionally exercises complete/reopen through the authorized wrapper after 007.

Run database suites only against a disposable PostgreSQL database: the test harness drops and recreates application schemas. Set TEST_DATABASE_URL and run the backend Vitest configuration, which serializes test files. Run backend/frontend tests, typechecks and builds before merging.

Hosted Supabase identity verification, actual email delivery and browser OAuth/mailbox replacement must still be smoke-tested in staging with configured accounts; local PostgreSQL tests use an auth schema shim.

## Rollback

Disable new provisioning/claims, retain the schema and guards, and forward-fix. Preserve memberships, canonical actors and audit history. Do not deploy a binary that treats every authenticated subject as an owner. The change protects owner/auth deletion with RESTRICT foreign keys; administrative deletion requires a separately designed tenant lifecycle.

## Local validation results

- Backend: 250 tests passed with disposable PostgreSQL (33 suites), including migration 007 and idempotent demo seed. Provider evidence tests mock Supabase Admin responses.
- Frontend: 91 tests passed (9 suites), including role boundaries and delayed resolution after logout.
- Backend/frontend typechecks and production builds passed. Changed UI files passed ESLint; repository-wide ESLint reports six existing unused imports in untouched files.
- Hosted migration, real OAuth/mailbox verification, and mail delivery have not been run; provisioning defaults to disabled until staging rollout.
