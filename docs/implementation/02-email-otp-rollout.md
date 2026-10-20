# Specification 02: email OTP login

Branch: `codex/email-otp-login`, based on specification 01. No new OTP endpoint, password, application OTP table, account merge, tenant creation or billing behavior.

## Implemented behavior

`/login` offers Google and, when enabled, email. Request addresses are normalized without changing plus aliases. One accessible six-digit input supports keyboard, paste and autofill. Requests and verification prevent duplicate submits. Resends wait at least 60 seconds and respect longer provider Retry-After responses; changing email clears the pending code and invalidates late work. Pending email/code are held only in component memory.

Supabase authenticates and issues sessions. `/me` independently resolves the stable provider subject and verified mailbox to a manager-assigned membership. Google and OTP use the same resolution. Unknown sign-ins never create a family. Identity conflicts show a generic recovery message, never household identity or provider account-existence details.

Protected destinations return through a validated local `returnTo`. Unknown paths, external/protocol-relative addresses, login loops and member management destinations are rejected. Dedicated no-access, revoked and access-error pages support retry or change account. Incomplete owners go to onboarding; unpaid drafts go to the merged owner subscription flow. Member dashboards are supplied by the merged specification 03.

Session transitions cancel prior `/me` work and family queries. Concurrent resolution for the same session deduplicates while active. Logout, expired authentication and failed resolution clear protected state. 401 responses return to neutral login once, without starting Google OAuth. Old-account responses cannot sign out the new account. Revocation responses clear protected queries and resolve current membership again. Late OTP results after logout/change-email cannot restore family access.

## Provider and sender setup

References: [Supabase email OTP](https://supabase.com/docs/guides/auth/auth-email-passwordless), [CAPTCHA](https://supabase.com/docs/guides/auth/auth-captcha), [rate limits](https://supabase.com/docs/guides/auth/rate-limits), [identity linking](https://supabase.com/docs/guides/auth/identities).

1. Deploy specification 01's compatible schema/backend/frontend first. Keep provider Google enabled. Allow frontend `/login` OAuth callbacks, preserving the local returnTo query. Preserve `/access-email-confirm` callback support for existing mailbox replacement.
2. Enable the Email provider and configure custom SMTP with an owned sender domain. Record sender owner, verified domain, quotas and delivery monitoring in deployment records; do not put credentials here.
3. Configure the Magic Link email template to display `{{ .Token }}` instead of relying on a link. Verify new-account confirmation as well as returning-user code delivery with owned test mailboxes. Configure six digits and proposed expiry of 600 seconds. The provider's default expiry is longer, so the client makes no expiry promise. Supabase's expiration setting also affects confirmation, recovery and email-change links; smoke-test specification 01 mailbox replacement together.
4. Configure provider-side request and verification limits, SMTP quotas and production bot protection. This app supports Cloudflare Turnstile: configure its secret in Supabase and its public site key in `VITE_AUTH_CAPTCHA_SITE_KEY`. Allow the frontend host on the Turnstile widget. Production CSP must permit the Turnstile script/frame/connect origins. A missing/failed widget blocks email requests when the site key is configured; Google remains available.
5. Set `VITE_EMAIL_OTP_ENABLED=true` only after staging verification. This is a public Vite **build-time** switch, passed through Docker Compose/Dockerfile. Restart Vite in development or rebuild the production bundle after changes. Default is false. No secret key belongs in frontend configuration.
6. For rollback rebuild with the switch false. Retain role guards, existing provider sessions, and neutral logout. The switch is not an abuse boundary: an attacker can invoke public Supabase Auth directly, so enforce limits and CAPTCHA at the provider.

The frontend custom Supabase fetch adapter reads only Retry-After for OTP requests because the installed SDK's AuthApiError omits response headers. UI cooldown is supplementary. The app does not claim which previously issued code remains usable; the provider decides.

## Staging evidence required before release

Use owned staging mailboxes and never real user invitations. Record results for:

- Fresh OTP signup and returning OTP login; existing Google owner and provisioned Manager/Member reach their original membership. Unknown OTP subject reaches NO_ACCESS with no new household.
- Google/email identity linkage with the same mailbox; different-subject conflict fails safely. Client matching never merges accounts.
- Invalid, expired, replayed and superseded codes; provider SMTP outage; template contains a code; successful delivery and sender ownership confirmed.
- Direct provider requests respect CAPTCHA, request cooldown, verification limits and quota. Provider limits remain effective without the application UI.
- Revocation during login, logout during verification, safe returnTo, failed `/me`, concurrent 401s and cached family data removal.
- Actual browser Google OAuth callback and bound-subject mailbox replacement after the provider template/expiry changes.
- Resolution latency from successful provider verification to usable application state, targeting p95 under three seconds (excluding delivery).

No hosted provider settings were changed and no OTP emails were sent during implementation. Those checks require an owned staging mailbox and configured sender. Membership schema presence and the local `/me` pipeline were checked against the configured project: an existing backfilled owner returned HTTP 200 READY with a controlled verifier. This checks provider-admin resolution and serialization, not a complete browser OAuth flow; the previously reported browser 500 was not reproduced and remains unconfirmed without its backend log.

## Operator conflict recovery

There is no automated recovery UI. Do not replace a claimed app_user_id based on matching email.

1. Verify old/new provider subjects and membership binding through authorized administrative tooling. Confirm mailbox control and account ownership using the approved support process; never solicit an OTP or bearer token.
2. Revoke affected access/sessions before an identity change. Preserve participant, household and ledger identifiers.
3. Prepare a reviewed, transactional data repair that preserves the canonical app-user identity, checks unique subject/email constraints and records an immutable audit event. A safe operation for transferring provider subjects is not exposed by this release; do not improvise an unaudited table update.
4. Verify both old session denial and restored login via the intended provider. Record recovery evidence without tokens, codes or raw mailbox addresses in operational metrics.

Operational signals are sanitized provider failure category, request/verification outcomes, `/me` latency, access conflicts and revocations. Existing Supabase Auth logs and backend request IDs support investigation; do not log codes/emails in application telemetry.

## Local validation

Frontend: 134 tests passed, covering provider calls, CAPTCHA token requirements, redirects, paste/cooldown, Retry-After, conflicts, cancellation, session switching and scope-specific API errors. Backend: 211 tests passed; 39 database-only tests skipped in this branch run (no backend/schema changes). Existing-owner `/me` diagnostic against configured Supabase returned 200 READY. Frontend/backend typechecks and frontend production build passed. Login choices were visually checked in a temporary local browser with the OTP flag enabled; no emails were sent.
