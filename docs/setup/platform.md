# Platform setup and deployment

Use separate Supabase projects, Stripe environments and secrets for staging and production. This guide configures the existing application; it does not require one deployment or database per tenant. Household rows share infrastructure with tenant isolation enforced in the API and database.

## 1. Prepare infrastructure

You need Node.js 20+, npm, a Supabase project, a static frontend host, an API host and a supervised long-running worker process. Docker Compose can run all three application services. Choose frontend and API HTTPS origins before production configuration.

From the repository root, install locked dependencies:

```sh
npm ci --prefix backend
npm ci --prefix frontend
```

## 2. Configure Supabase and database

1. Create the project and obtain its URL, publishable key and backend-only secret key. Configure backend `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`; configure the matching public `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` in the frontend.
2. Back up an existing environment. Rehearse migrations on a staging copy and record existing family/ledger/completion counts. Apply only unapplied SQL files in `backend/src/supabase/migrations/`, in numeric order through **011**. Keep a deployment migration ledger; do not rerun all files against an existing installation.
3. For a fresh database only, with a private connection string configured in your shell, run from the repository root:

   ```sh
   (
     for migration in backend/src/supabase/migrations/0*.sql; do
       psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$migration" || exit 1
     done
   )
   ```

4. Check that every migration succeeded before deployment. The optional `backend/src/supabase/seed.sql` is demo data, not a customer-provisioning process; omit it in production. Migration 007 deliberately aborts on ambiguous identity backfills; investigate conflicts instead of rewriting ownership.

## 3. Keep Google authentication working

1. Create a Google Web OAuth client. Register Supabase's callback `https://PROJECT_REF.supabase.co/auth/v1/callback` in that client's authorized redirect URIs.
2. Enable Supabase's Google provider with that client ID and secret. Keep the secret in provider configuration.
3. Set Supabase Site URL to the frontend origin. Allow the frontend's `/login` callback, including the local `returnTo` query patterns used by the application, and `/access-email-confirm` for mailbox replacement. Configure localhost separately for development; scope production redirects to the intended host/paths.
4. Set backend `CORS_ORIGIN` to exact frontend origins, comma-separated with no trailing slash, and frontend `VITE_API_URL` to the browser-reachable API origin (without `/api/v1`). Both apps must use the same Supabase project.
5. Smoke-test an existing Google Owner and check `/api/v1/me` returns the original family and role. Logging in must not create another household.

Supabase maintains the redirect allowlist independently of Google's provider callback. See [Supabase redirect URL configuration](https://supabase.com/docs/guides/auth/redirect-urls).

## 4. Enable email-code login

1. Enable the Supabase Email provider and set up an owned sender with custom SMTP. Test sender delivery and quotas; see [custom SMTP](https://supabase.com/docs/guides/auth/auth-smtp).
2. Configure the Magic Link email template to display `{{ .Token }}`. Validate both new and returning account mail flows with six-digit OTP. Configure an approved provider expiry; the detailed rollout proposes 600 seconds but the app does not enforce or promise that expiry.
3. Configure provider request/verification limits and production CAPTCHA. For Turnstile, put its secret in Supabase and public site key in `VITE_AUTH_CAPTCHA_SITE_KEY`; allow the frontend host and required script/frame origins in your CSP.
4. Set `VITE_EMAIL_OTP_ENABLED=true`, rebuild the frontend and test OTP plus existing Google sign-in. Supabase authenticates the mailbox; the backend independently assigns access from the provisioned membership. Never derive role from the submitted address.
5. Test invalid/expired codes, resend, logout and revoked access. Retest mailbox replacement because Auth email settings can affect other confirmation flows. Details: [OTP rollout](../implementation/02-email-otp-rollout.md).

## 5. Enable membership and tenant capabilities

After migrations and staging acceptance, set `MEMBERSHIP_ACCESS_ENABLED=true` and `MEMBER_VIEWS_ENABLED=true` on API and worker. Configure mailbox replacement delivery if required. Follow [tenant setup](tenants.md) for the first Owner and role provisioning. Keep `SELF_SERVICE_SIGNUP_ENABLED`, `BILLING_AVAILABLE` and `CHECKOUT_ENABLED` false while preparing billing; an unconfigured new tenant otherwise remains a saved unpaid draft.

## 6. Configure SaaS billing

Follow [Stripe setup](stripe.md) before enabling public signup. Configure one approved monthly plan, portal, signed webhook endpoint, entitlement policy and worker. Publish policy by starting the worker before opening checkout. Use [environment reference](environment.md) to keep API and worker configuration aligned.

## 7. Run and deploy

For native development, copy `backend/.env.example` and `frontend/.env.example` into their respective `.env` files. Use `npm run dev --prefix backend`, `npm run dev --prefix frontend` and, after Stripe configuration, `npm run worker:dev --prefix backend` in separate terminals.

For Compose, use root `.env` and:

```sh
docker compose --profile billing up -d --build
docker compose ps
docker compose logs --tail=100 backend billing-worker
```

Compose sets `NODE_ENV=production`, so billing origins and legal URLs must be HTTPS. Without Stripe credentials, omit `--profile billing` for an API/SPA-only run. On other hosts, build backend with `npm run build --prefix backend`, run API with `npm start --prefix backend` and a separate supervised worker with `npm run worker --prefix backend`. Do not use an HTTP request, cron invocation or static hosting function as the worker.

Deploy schema first, API/worker next, frontend last. Serve the SPA with fallback to `index.html` for deep links such as `/login`, `/onboarding`, `/subscribe` and `/billing`. The included nginx listens on fixed port **8080**; adapt hosting configuration when the platform requires another port. Inject runtime secrets into API/worker; frontend public values must be present during build.

## 8. Acceptance and ongoing operation

Check `/api/v1/health`, `/api/v1/ready`, Google/OTP, existing legacy access, member privacy, draft isolation, TEST payment activation, duplicate webhooks, read-only expiry and owner portal recovery. API readiness alone does not prove that the worker or payment projection is healthy. Monitor worker heartbeat and queue age using the [entitlement runbook](../implementation/06-subscription-entitlements-rollout.md).

Enable public signup only after successful staged purchase/recovery and approved commercial settings. For LIVE, create matching live resources and secrets, verify mode/account/version, repeat deployment checks and publish a new approved policy version as needed. A TEST price or secret cannot be reused in LIVE. This documentation update performs no provider configuration, deployment or charges.
