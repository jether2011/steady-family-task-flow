# Family Task Board

A multi-tenant SaaS for family tasks, points and rewards. Each household is a tenant with an Owner, optional Managers and read-only Members. Google and email-code authentication resolve the same server-managed memberships. Owners can create a household explicitly, subscribe through Stripe Checkout and manage payment through the hosted customer portal.

All six access and SaaS specifications are merged. Feature switches remain disabled in the templates until the corresponding provider settings and deployment acceptance are complete. Merging code does not configure Supabase, Stripe or production policy.

## Start here

| Goal | Guide |
| --- | --- |
| Configure a fresh environment, authentication and deployment | [Platform setup](docs/setup/platform.md) |
| Create a tenant, provision roles and understand restricted access | [Tenants and members](docs/setup/tenants.md) |
| Configure Stripe, policy, worker and test purchases | [Stripe and subscriptions](docs/setup/stripe.md) |
| Look up every environment variable | [Configuration reference](docs/setup/environment.md) |
| API development, migrations and database tests | [Backend README](backend/README.md) |
| UI development and static deployment | [Frontend README](frontend/README.md) |
| Design and historical rollout evidence | [Documentation index](docs/README.md) |

## Architecture

| Component | Responsibility |
| --- | --- |
| `frontend/` — React, Vite, TanStack Query | Login, tenant onboarding, role-aware boards/history and owner billing UI |
| `backend/` — Fastify, TypeScript | Verify Supabase JWTs; resolve membership; enforce API permissions and privileged database operations |
| Supabase — Auth and PostgreSQL | Google/email sessions, tenant data, RLS, atomic ledger and transaction-boundary authorization |
| Billing/entitlement worker — separate Node process | Durable Stripe reconciliation, payment evidence, entitlement projection and activation receipts |
| Stripe — hosted Checkout and portal | Payment collection, subscription and payment-method management |

The browser sends its Supabase bearer token to `/api/v1`; it never receives backend credentials or Stripe secrets. Family ID is the tenant ID. Membership and role are independent of subscription state. Product writes recheck all three under database locks; expiration leaves established tenants with authorized read-only history. Frontend queries poll authorized APIs and clear caches when identity or access changes.

## Local start

Prerequisites: Node.js 20+, npm, a configured Supabase project, and optionally Docker Compose. Complete [platform setup](docs/setup/platform.md) first, including migrations 001–011 and Auth redirects.

```sh
cp .env.example .env
# Fill the root .env with your environment's values.
docker compose up --build
```

Frontend: `http://localhost:5173`. API: `http://localhost:8080/api/v1`. OpenAPI: `http://localhost:8080/api/docs`. For SaaS billing, configure Stripe first and include the worker:

```sh
docker compose --profile billing up --build
```

Compose runs the backend with `NODE_ENV=production`; its public app and legal URLs therefore require HTTPS even on a local machine. Use native development for localhost HTTP billing tests, or use HTTPS development endpoints. The root `.env` configures Compose; native processes use their own app `.env` files.

Without Docker, use separate terminals from the repository root:

```sh
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env
npm ci --prefix backend
npm ci --prefix frontend
npm run dev --prefix backend
# In another terminal:
npm run dev --prefix frontend
# After Stripe configuration, in a third terminal:
npm run worker:dev --prefix backend
```

`VITE_*` values are public build-time settings. Restart Vite or rebuild the frontend after changing them. API and worker settings are server-side runtime values; restart both after changes.

## User journey

1. Sign in with Google or enabled email OTP. `/me` resolves identity and membership without creating a tenant.
2. An eligible unassociated user explicitly creates a family when signup is enabled. Reserved or revoked identities cannot create another household.
3. The Owner completes the profile and purchases the configured plan. A saved draft cannot use product pages.
4. The worker verifies payment and atomically establishes the same family with an activation receipt. A successful return URL alone grants no access.
5. Owners/Managers provision participants and optional login access, assign tasks and manage rewards. Members see permitted boards, standings, their points and history.
6. On entitlement expiry, an established household retains authorized read-only views. The Owner can recover billing; authorized managers can still revoke login access.

## Verification

```sh
npm test --prefix backend
npm test --prefix frontend
npm run typecheck --prefix backend
npm run typecheck --prefix frontend
npm run build --prefix backend
npm run build --prefix frontend
```

Database tests skip unless `TEST_DATABASE_URL` names a **disposable** PostgreSQL database; the harness drops/rebuilds schemas. See [backend testing](backend/README.md#testing). The merged Specification 6 verification recorded 445 backend and 181 frontend tests; those are historical results, not a claim that provider or production acceptance has been performed in this environment.

## Deployment

Apply pending migrations once through a tracked migration process, deploy API and supervised worker with matching configuration, then build/deploy the SPA. Configure HTTPS, CORS and Supabase redirects for the deployed origins. Verify Google login, roles, draft isolation, real TEST-account billing and recovery before enabling production signup or checkout. Follow the [platform sequence](docs/setup/platform.md) and [Stripe release steps](docs/setup/stripe.md).

## Project layout

```text
backend/src/modules/           Auth, membership, tenant, billing, entitlements and product APIs
backend/src/supabase/migrations/ SQL migrations 001–011
backend/src/billing-worker.ts  Billing and entitlement worker/operations CLI
frontend/src/                 SPA, typed API client and scoped query hooks
docs/setup/                   Current operator configuration guides
docs/implementation/          Feature rollout details and implementation evidence
docs/specifications/          Six feature specifications
docs/product/                 Product requirements
docker-compose.yml            API + SPA, optional billing worker profile
```
