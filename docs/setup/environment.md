# Environment configuration reference

Sources of truth: `backend/src/config/env.ts`, `backend/src/modules/billing/billing.config.ts`, app `.env.example` files and `docker-compose.yml`. Blank optional billing values are treated as unset. Use literal `true`/`false` for switches. Never commit real `.env` values.

## Where configuration goes

| Run mode | Configuration source | Apply changes |
| --- | --- | --- |
| Native API/worker | `backend/.env`, loaded by npm scripts; host environment can also supply values | Restart API and worker |
| Native frontend | `frontend/.env` | Restart Vite or rebuild |
| Docker Compose | Root `.env` / host environment, explicitly mapped in Compose | Recreate API/worker; rebuild SPA for public changes |
| Hosted API/worker | Platform secret/configuration store | Restart/redeploy both processes |
| Hosted SPA | Public build environment | Rebuild/redeploy static bundle |

Do not copy a backend `.env` into the frontend. Supabase/Stripe/delivery secrets are server-only. Both server processes use the same Supabase, merchant, mode and policy version. `SUPABASE_JWKS_URL` is an optional native/hosted override; Compose does not map it, so add an explicit deployment override if required.

## Core API and identity

| Variable | Required/default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | API port; Compose fixes it to 8080 |
| `NODE_ENV` | `development` | `development`, `test`, `production`; Compose fixes production |
| `SUPABASE_URL` | Required | Supabase project URL |
| `SUPABASE_PUBLISHABLE_KEY` | Required | Public key used for user-scoped operations |
| `SUPABASE_SECRET_KEY` | Required, secret | Privileged API/worker key |
| `SUPABASE_JWKS_URL` | Derived if absent | Optional JWT verification endpoint override |
| `CORS_ORIGIN` | Required | Comma-separated exact frontend origins; no wildcard in production |
| `PUBLIC_APP_URL` | Required for checkout/mailbox replacement | Frontend origin, HTTPS in production; no path/query/fragment |
| `ACCESS_EMAIL_DELIVERY_URL` | Optional HTTPS URL | Claimed-mailbox replacement delivery adapter, separate from Supabase SMTP |
| `ACCESS_EMAIL_DELIVERY_TOKEN` | Optional, secret | Adapter bearer credential; configure with delivery URL |

## Feature switches

| Variable | Default | Effect |
| --- | --- | --- |
| `MEMBERSHIP_ACCESS_ENABLED` | `false` | Enables membership claim/provisioning rollout |
| `MEMBER_VIEWS_ENABLED` | `false` | Enables member read-model capability |
| `SELF_SERVICE_SIGNUP_ENABLED` | `false` | Enables explicit eligible tenant creation; existing owner resume remains available |
| `BILLING_AVAILABLE` | `false` | Reports billing availability; does not grant paid access |
| `CHECKOUT_ENABLED` | `false` | Enables new hosted purchase; requires billing availability and complete commercial/entitlement config |
| `ENTITLEMENT_ENFORCEMENT_ENABLED` | `false` | Reviewed legacy enforcement rollout; does not waive SELF_SERVICE payment requirements |
| `ENTITLEMENT_TRIALS_ENABLED` | `false` | Recognizes explicitly permitted trial facts; not a trial creation UI |

Disabling a UI/server switch does not undo persisted memberships, subscriptions, activated cohorts or pinned deadlines. Use the operations guides for rollback.

## Stripe and commercial settings

All values below except retry count/mode are unset in templates. Checkout startup validation requires the complete commercial configuration, webhook secret, event retention and entitlement policy. Runtime plan validation additionally checks provider records.

| Variable | Format / meaning |
| --- | --- |
| `STRIPE_MODE` | `TEST` (default) or deliberately configured `LIVE` |
| `STRIPE_SECRET_KEY` | Secret `sk_test_…` or `sk_live_…`, matching mode |
| `STRIPE_WEBHOOK_SECRET` | Secret `whsec_…` for this endpoint/listener |
| `STRIPE_ACCOUNT_ID` | Matching merchant account ID |
| `STRIPE_MERCHANT_COUNTRY` | Merchant country matching provider account |
| `STRIPE_PRICE_ID` | Active recurring licensed monthly Price; amount is retrieved from Stripe |
| `STRIPE_PORTAL_CONFIGURATION_ID` | Same-environment active `bpc_…` with supported portal policy |
| `BILLING_PLAN_TITLE` | Approved display title |
| `BILLING_PLAN_FEATURES` | Pipe-separated nonempty feature descriptions |
| `BILLING_MEMBER_LIMIT` | Positive integer or literal `unlimited` |
| `BILLING_CURRENCY` | Approved lowercase currency matching Price |
| `BILLING_TAX_BEHAVIOR` | `inclusive` or `exclusive`, matching Price |
| `BILLING_AUTOMATIC_TAX` | Explicit `true` or `false` |
| `BILLING_PAYMENT_METHODS` | Currently only `card` |
| `BILLING_TERMS_URL` | Approved HTTPS terms URL |
| `BILLING_PRIVACY_URL` | Approved HTTPS privacy URL |
| `BILLING_POLICY_URL` | Approved HTTPS cancellation/refund policy URL |
| `BILLING_TAX_DISCLOSURE` | Human-readable approved disclosure |
| `BILLING_APPROVAL_REFERENCE` | Commercial review/reference identifier |
| `BILLING_EVENT_RETENTION_DAYS` | Integer 1–365; operational event references, not full financial-retention policy |
| `BILLING_MAX_RETRIES` | Integer 1–30; default 10 |

URL fields reject credentials, query strings and fragments. Localhost HTTP is allowed only outside production; legal URLs may have paths while `PUBLIC_APP_URL` is an origin. No amount, currency, cap or tax default is invented by the application.

## Entitlement policy

Publishing a version, enabling checkout/enforcement/trials requires a complete policy, matching Stripe account/price and explicit member limit. The worker publishes it. Changing immutable content requires a new version.

| Variable | Format / meaning |
| --- | --- |
| `ENTITLEMENT_POLICY_VERSION` | Unique immutable approved version |
| `ENTITLEMENT_POLICY_APPROVAL` | Policy review/reference identifier |
| `RENEWAL_GRACE_DAYS` | Integer 0–90; no default |
| `PROVIDER_OUTAGE_TOLERANCE_HOURS` | Integer 0–168; no default |
| `LEGACY_ENTITLEMENT_DEADLINE` | ISO date-time with timezone; required when enforcement is enabled |
| `ENTITLEMENT_EXCEPTION_POLICY` | Explicit literal `RESTRICT` |

Trial and enforcement switches are listed above. Approved policy is persisted in PostgreSQL; changing only an API environment variable does not publish a new database policy. Restart the configured worker and verify publication.

## Frontend public build values

| Variable | Required/default | Meaning |
| --- | --- | --- |
| `VITE_API_URL` | Required | Browser-visible API origin, without `/api/v1` |
| `VITE_SUPABASE_URL` | Required | Same project as API |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Required | Public Supabase key |
| `VITE_EMAIL_OTP_ENABLED` | `false` | Show email code login after provider setup |
| `VITE_AUTH_CAPTCHA_SITE_KEY` | Optional | Public Turnstile site key; private secret belongs in Supabase |

No Stripe publishable key is needed for this hosted redirect integration. Custom SMTP credentials and provider CAPTCHA secrets belong in Supabase, not these env files.

## Test-only connection

`TEST_DATABASE_URL` supplies a disposable PostgreSQL database to backend tests. It is not the application's Supabase URL and must never point at customer/staging/production data: tests drop/recreate schemas. Configure any required core env values for the test process too; see the backend README.
