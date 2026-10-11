# Specification 2: Email OTP login

Date: 2026-10-11 · Status: Design draft · Branch: `codex/email-otp-login`

Depends on [membership foundation](01-tenant-membership-roles.md). Source: [PRD](../product/PRD-family-access-and-saas.md); [shared conventions](README.md).

## Outcome and boundaries

Add passwordless email code authentication while retaining Google OAuth. An authenticated person reaches the existing family with its assigned role, or an explicit no-access state. Logout, session expiration and failures return to neutral login choices.

No passwords, application-generated OTPs, role inference from email, automatic tenant creation, or custom provider-account merging. This feature consumes `/me`; it does not redesign membership resolution. Proposed lifetime is 10 minutes and resend cooldown at least 60 seconds, subject to provider configuration review.

## Provider integration contract

Use the existing frontend Supabase client:

```ts
await supabase.auth.signInWithOtp({
  email: normalizedEmail,
  options: { shouldCreateUser: true, captchaToken }
});
await supabase.auth.verifyOtp({
  email: normalizedEmail,
  token: code,
  type: 'email'
});
```

Include `captchaToken` when configured/required; omit rather than pass undefined if the installed SDK requires it. `shouldCreateUser: true` allows first login for provisioned people without auth accounts and prospective owners; only specification 4 can create a tenant. No client-auth API key beyond existing public key is added.

The provider sends a code only when its email template uses the token value. Enable email provider, configure code template and custom SMTP/sender, and test code-based signup as well as returning-user login. Confirm provider support for proposed expiration and throttling in staging. Provider setting changes can affect other email verification links; test email-change flows together. The method names, signup behavior and template requirement are documented by [Supabase passwordless email auth](https://supabase.com/docs/guides/auth/auth-email-passwordless).

Google continues through `signInWithOAuth({ provider:'google', options:{ redirectTo: approvedOrigin + '/' } })`. Exact frontend origins must be allowlisted. Do not force a second OAuth flow when an API request fails.

No new application OTP REST endpoints or OTP database table. Provider request/verification enforcement is mandatory because an attacker can call the public Supabase Auth endpoint directly; a button cooldown is only UI behavior. Production uses provider CAPTCHA/rate controls and email quotas, with verified staging abuse tests. If provider limits are insufficient, specify a provider-supported enforcement hook before enabling production; an easily bypassed backend proxy is not an acceptable security fix.

## Login UI and state machine

Add explicit `/login` route outside the protected application. Existing protected URLs redirect there with a validated local `returnTo` value.

| State | Display/action | Transition |
| --- | --- | --- |
| EMAIL_ENTRY | Email field, Continue with email, Google choice | Valid normalized address → SENDING |
| SENDING | Disabled submit; accessible progress | Success → CODE_ENTRY; safe error → EMAIL_ENTRY |
| CODE_ENTRY | Code field, masked/entered email, resend countdown, Change email | Six numeric digits → VERIFYING |
| VERIFYING | Disable duplicate verification | Provider session → RESOLVING_ACCESS; rejection → CODE_ENTRY |
| RESOLVING_ACCESS | Block protected pages; fetch `/me` | READY → authorized destination; other union state → corresponding screen |
| ACCESS_ERROR | Retry resolution, change account, support message | Retry `/me`; never load a default family |
| SIGNED_OUT | Clear context/cache/subscriptions | EMAIL_ENTRY or current authenticated provider choice screen |

Use one input with `inputMode='numeric'`, `autoComplete='one-time-code'`, label and six-digit validation; segmented visuals may wrap one accessible value. Support paste/autofill without accidental multiple submits. Wrong/expired codes share “This code is invalid or expired. Request a new code.” Delivery responses say “If the request can be processed, a code will be sent.” Format validation can identify invalid syntax, never tenant membership.

Resend: initial 60-second countdown, respect provider Retry-After if longer, keep email fixed to request context. Re-sending resets UI expiration estimate; provider validates which code remains valid. Test superseded code behavior and do not promise provider behavior that has not been verified. Changing email cancels pending work and clears code/timers. Keep pending address in memory; refresh restarts entry, not a replayable sessionStorage OTP.

## Session and redirect behavior

Refactor `AuthContext.jsx` to expose `loginWithGoogle`, `requestEmailCode`, `verifyEmailCode`, `logout`, `retryAccessResolution` and context state. Retain temporary aliases only where needed for existing callers; `redirectToLogin` navigates to `/login` and never starts OAuth.

Use provider session events to update identity, then perform `/me` work outside the synchronous auth callback. Deduplicate resolution by session identity plus active request generation, not a permanent once-per-user bootstrap ref. Token refresh does not create rows/families; resolve on focus and periodic access checks. A failed `/me` keeps `authChecked` false for family rendering and displays retry.

Race handling: each session transition increments a generation counter, aborts previous API/query requests and clears prior context. A late Google/OTP or `/me` result from an older generation cannot render pages for the current user. Logout awaits provider sign-out where possible but always clears local protected state; report failed remote sign-out safely without restarting login.

`returnTo` accepts same-origin relative application routes only; reject protocol-relative URLs, login-loop routes and privileged destinations the role cannot access. MEMBER trying `/settings` after login lands on home with an access message. NO_ACCESS → `/no-access`; revoked → `/access-revoked`; OWNER incomplete → `/onboarding`; PAYMENT_REQUIRED → `/subscribe`. These routes consume the union contract and do not fabricate family context.

On 401, clear context and return to login once; suppress redirect loops from parallel requests. On 403 ACCESS_REVOKED, re-resolve and remove protected data. Distinguish network/server resolution errors from expired authentication. Map provider errors to sanitized UI messages; do not copy provider account existence details into the app.

## Identity conflicts and recovery

Provider user subject is the stable identity. Same-email Google and email login must resolve the same application membership when the provider links identities. Do not implement a custom merge based on matching client email; [Supabase identity documentation](https://supabase.com/docs/guides/auth/identities) distinguishes auth users from their provider identities.

For a different subject matching an already-claimed membership, `/me` yields `409 ACCESS_CONFLICT`; show “We could not safely connect this sign-in. Try your previous sign-in method or contact support.” Do not disclose family details or override binding. Operator recovery must verify old/new provider identities, obtain proof of mailbox/account control, revoke old sessions, and atomically preserve the app-user/membership identity mapping with audit. No automated recovery UI is included; staging needs a documented operator runbook. Email replacement uses specification 1's bound-subject confirmation contract.

## Implementation tasks and touched areas

1. Extend `Login.jsx`, add neutral login/no-access/revoked/error routes and accessible code input.
2. Refactor `AuthContext.jsx`, `ProtectedRoute`, API client's unauthorized callback and safe `authReturnTo` handling.
3. Wire provider session to `/me`, deduplication, cancellation and cache cleanup contracts.
4. Configure hosted provider email template, SMTP, expiry, CAPTCHA and redirects; document local/staging/production steps without credentials.
5. Add provider conflict/recovery and deliverability runbook; refresh README descriptions when implemented.

## Validation and completion

| Coverage | Required scenarios |
| --- | --- |
| Component | Email validation, six-digit paste, resend timer, change email, keyboard/screen-reader labels, pending state double-click prevention |
| AuthContext | First OTP session → `/me`; Google retained; logout and 401 never auto-OAuth; late session response rejected; resolution failure blocks family fetch |
| Access | Manager-assigned MEMBER/MANAGER routed to original family; existing OWNER preserves identity; unknown email creates no family |
| Provider staging | Fresh email signup, existing OTP login, Google/email same identity, verified email evidence, wrong/expired/replayed/superseded code, SMTP failure |
| Abuse | Direct provider requests respect cooldown/verification controls/CAPTCHA; UI cannot bypass enforcement; neutral messages |
| Redirect | Safe local destination retained; external/protocol-relative and unauthorized returnTo blocked |

Do not send real user invitation emails during tests. Use owned staging mailboxes and measure dashboard resolution from provider verification response to usable page; proposed p95 target is 3 seconds, excluding delivery.

Release `EMAIL_OTP_ENABLED` after specification 1 is deployed. Kill switch hides new email request UI; it does not invalidate legitimately issued provider sessions or turn Members into owners. Retain role resolution and neutral logout on rollback. Metrics: request/verify outcome counts, sanitized provider failure category, resolution latency and conflict count; no raw email or OTP. Completion requires frontend suites/typecheck/build, backend identity tests, provider staging evidence and documented sender ownership.

Traceability: AUTH-01–09; MEM-02/06; VIEW-08. No price or new subscription behavior is introduced here.
