# Family Task Board - Backend

A Node.js + TypeScript REST API built on Fastify 5, backed by a hosted Supabase (PostgreSQL) project. It verifies Supabase-issued JWTs, resolves each caller's family, and owns all privileged writes - the points ledger runs through atomic PostgreSQL functions invoked with the Supabase secret key. Reads additionally rely on row-level security.

- Base path: `/api/v1`
- Interactive API docs (OpenAPI): `/api/docs`
- Liveness: `/api/v1/health` - Readiness: `/api/v1/ready`

> `GET /api/v1/me` resolves identity and membership without creating a family.
> Explicit owner creation uses `POST /api/v1/families`; unpaid drafts remain
> behind the onboarding/subscription boundary. See the [tenant rollout guide](../docs/implementation/04-tenant-onboarding-rollout.md).

Current operator instructions: [platform setup](../docs/setup/platform.md), [tenant provisioning](../docs/setup/tenants.md), [Stripe setup](../docs/setup/stripe.md), and the [complete environment reference](../docs/setup/environment.md).

## Tech stack

- Node 20, ESM, strict TypeScript (NodeNext)
- Fastify 5 with `fastify-type-provider-zod` and `@fastify/swagger`
- `@supabase/supabase-js`, `jose` (JWKS verification), `pino` logging, `zod` validation
- Vitest + Supertest + fast-check for tests

## Prerequisites

- Node.js 20+ and npm
- A Supabase project with the Google OAuth provider enabled and the migrations applied (see the root README's "One-time Supabase setup"). The backend will not start without valid Supabase env values and cannot serve data until the schema exists.

## Run locally (step by step)

```bash
cd backend
cp .env.example .env     # 1. create your env file
# 2. edit .env and fill in the real Supabase values:
#    SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, SUPABASE_SECRET_KEY, CORS_ORIGIN
npm install              # 3. install dependencies
npm run dev               # 4. start the dev server (tsx watch) on http://localhost:8080
```

Verify it is up:

```bash
curl http://localhost:8080/api/v1/health     # -> {"status":"ok",...}
open http://localhost:8080/api/docs           # browse the OpenAPI UI
```

The server fails fast with a clear, secret-free error if any required env var is missing.

## Environment variables

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `PORT` | no | `8080` | Port the server binds to (0.0.0.0:PORT) |
| `NODE_ENV` | no | `development` | `development` / `test` / `production`. In production CORS rejects wildcards. |
| `SUPABASE_URL` | yes | - | Supabase project URL |
| `SUPABASE_PUBLISHABLE_KEY` | yes | - | Publishable (public) key `sb_publishable_...` for user-scoped requests. (Replaces the legacy anon key.) |
| `SUPABASE_SECRET_KEY` | yes | - | Secret key `sb_secret_...` for atomic ledger writes. Backend only - never expose. (Replaces the legacy service_role key.) |
| `SUPABASE_JWKS_URL` | no | derived from `SUPABASE_URL` | Optional override of the JWKS endpoint used to verify user JWTs. |
| `CORS_ORIGIN` | yes | - | Comma-separated allowed origins, no trailing slash. No wildcard in production. |

`.env` is git-ignored and is never baked into the Docker image.

The table above covers core values only. Membership, signup, Stripe, entitlement policy and delivery settings are documented in the [complete environment reference](../docs/setup/environment.md). API and worker must use matching configuration.

## npm scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Watch mode via tsx on `src/server.ts` |
| `npm run build` | Compile TypeScript to `dist/` (tsc) |
| `npm start` | Run the compiled server (`node dist/server.js`) |
| `npm test` | Run the Vitest suite |
| `npm run typecheck` | Type-check without emitting |
| `npm run worker:dev` | Run the durable billing/entitlement worker in development |
| `npm run worker` | Run the compiled supervised worker |

## Database migrations

The schema lives in `src/supabase/migrations/` as plain SQL, applied in numeric order, plus `src/supabase/seed.sql` for demo data.

| File | Purpose |
| --- | --- |
| `001_initial_schema.sql` | Tables, enums (as TEXT + CHECK), FKs, uniqueness constraints |
| `002_indexes.sql` | Family-scoped indexes + recurring-generation idempotency index |
| `003_rls.sql` | Row-level security policies (ledger writes are secret-key only) |
| `004_functions.sql` | Atomic `complete_task` / `reopen_task` / `redeem_award` + `updated_at` trigger |
| `005_realtime.sql` | Adds tables to the `supabase_realtime` publication |
| `006_update_family.sql` | Atomic family/responsible-user update function |
| `007_membership_access.sql` | Canonical identities, owner backfill, memberships, transactional authorization and role policies |
| `008_member_views.sql` | Snapshot member reads, safe directory/profile, aggregate ranking, history indexes |
| `009_tenant_onboarding.sql` | Explicit unpaid drafts, idempotent creation, owner onboarding, legacy access policy and lifecycle gates |
| `010_stripe_billing.sql` | Durable billing accounts, checkout attempts, webhook inbox, fenced worker, audit and entitlement outbox |
| `011_subscription_entitlements.sql` | Versioned access projection, strict write enforcement, bounded rollout and read-only recovery |
| `seed.sql` | Idempotent demo family data |

For a fresh database, apply them with one of these methods. For an existing database, apply only pending files according to your deployment ledger:

- Dashboard SQL Editor: paste each file in order and run.
- If you use a Supabase CLI migration workflow, first integrate these files into that tracked workflow. This repository keeps SQL under `src/supabase/migrations/`; it does not provide a standard `supabase/migrations/` project for an unconfigured `supabase db push`.
- psql against the connection string from Project Settings -> Database:

```bash
(
  for f in src/supabase/migrations/0*.sql; do
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f" || exit 1
  done
)
psql "$DATABASE_URL" -f src/supabase/seed.sql    # optional demo data
```

Apply migrations once in order using a migration ledger. Migration 007 is intentionally applied once and aborts on identity collisions. The demo seed remains idempotent. See [membership rollout](../docs/implementation/01-membership-rollout.md).

## API routes

All routes are under `/api/v1` and (except ops probes and the Stripe-signature-authenticated webhook) require a
`Authorization: Bearer <supabase-jwt>` header. Identity and `family_id` are
always derived from the verified session — never from the request body.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/me` | Resolve verified identity, membership, role, routing and entitlement; never creates a tenant |
| POST | `/families` | Explicit eligible tenant creation with UUID Idempotency-Key |
| GET / PATCH | `/family/onboarding` | Owner profile recovery/setup for the same tenant |
| GET | `/billing/plan` | Owner plan/configuration availability |
| GET | `/billing/subscription` | Owner subscription and recovery state |
| POST | `/billing/checkout` | Owner hosted checkout with idempotency |
| GET | `/billing/checkout/:attemptId` | Owner activation/attempt status |
| POST | `/billing/portal` | Owner hosted payment recovery |
| POST | `/billing/webhooks/stripe` | Raw signed Stripe event ingestion, no bearer token |
| POST | `/family/members/:id/access/revoke` | Narrow versioned login revocation, including read-only tenants |
| GET | `/family` | Fetch the composed family DTO |
| PATCH | `/family` | Update established family settings (owner draft setup uses /family/onboarding) |
| GET | `/family/members` | List members (`?active=true` to filter) |
| POST | `/family/members` | Create a member |
| PATCH | `/family/members/:id` | Update a member (incl. toggling `active`) |
| DELETE | `/family/members/:id` | Soft-delete a member (sets `active=false`) |
| GET | `/family/tasks` | List tasks (filters: `date`, `weekStart`, `status`, `memberId`, `priority`) |
| POST | `/family/tasks` | Create a task |
| PATCH | `/tasks/:id` | Update a task |
| DELETE | `/tasks/:id` | Delete a task |
| POST | `/tasks/:id/move` | Move a task between non-DONE board columns |
| POST | `/tasks/:id/complete` | Complete a task and award its points (atomic) |
| POST | `/tasks/:id/reopen` | Reopen a completed task and reverse its points (atomic) |
| POST | `/family/tasks/carry-over` | Carry unfinished tasks into a target period |
| GET | `/family/task-templates` | List recurring templates |
| POST | `/family/task-templates` | Create a template |
| PATCH | `/task-templates/:id` | Update a template |
| DELETE | `/task-templates/:id` | Deactivate a template |
| POST | `/family/task-templates/generate` | Generate tasks for a week from active templates |
| GET | `/family/points` | List points-ledger entries (filters: `memberId`, `from`, `to`) |
| GET | `/family/leaderboard` | Leaderboard for a `period` (today/week/month/all) |
| GET | `/family/members/:id/completions` | A member's completions + ledger |
| GET | `/family/awards` | List awards |
| POST | `/family/awards` | Create an award |
| PATCH | `/awards/:id` | Update an award |
| DELETE | `/awards/:id` | Deactivate an award |
| POST | `/awards/:id/redeem` | Redeem an award against a member's balance (atomic) |
| GET | `/family/dashboard` | Dashboard aggregate (family, active members, today's tasks, totals) |
| GET | `/family/board` | Weekly board aggregate for a `weekStart` |
| GET | `/health`, `/ready` | Liveness / readiness probes (no auth) |

Create bodies are validated with strict Zod schemas: unknown keys (e.g. a
client-supplied `family_id`, `active`, or a task's initial `status`) are
rejected as `422 VALIDATION`, since those are server-derived.

## Testing

```bash
npm test
```

By default the database-backed integration and property suites skip gracefully (no database required), so this run is fast and green. To exercise the full suite - including all 14 fast-check correctness properties - point it at a disposable Postgres:

```bash
docker run --rm -d -p 55432:5432 -e POSTGRES_PASSWORD=pg --name ftb-pg postgres:16-alpine
SUPABASE_URL=https://project.supabase.co SUPABASE_PUBLISHABLE_KEY=test \
SUPABASE_SECRET_KEY=test CORS_ORIGIN=http://localhost:5173 \
TEST_DATABASE_URL=postgresql://postgres:pg@127.0.0.1:55432/postgres npm test
docker rm -f ftb-pg
```

Never use a customer or shared environment database for `TEST_DATABASE_URL`; the harness drops schemas. The DB-backed suites rebuild the schema per run and are serialized (see `vitest.config.ts`) so they do not race on the shared database.

## Build and run with Docker

The `Dockerfile` is multi-stage and runs as a non-root user. No secrets are baked in - config is injected at runtime.

```bash
docker build -t ftb-backend ./        # from the backend/ directory
docker run --rm -p 8080:8080 --env-file .env ftb-backend
```

## Deployment

SaaS billing also requires a separate supervised `npm run worker` process using the same built image and configuration (container command `node dist/billing-worker.js`). The API process alone does not reconcile subscriptions or activate tenants. See [Stripe deployment](../docs/setup/stripe.md).

The backend is a long-running HTTP server, so host it somewhere that keeps a process alive (a container host, Heroku dyno, or VPS). Before deploying anywhere: finish the Supabase setup and apply the migrations, then set the env vars on the host. After the frontend is live, set `CORS_ORIGIN` to the frontend's public origin and add that origin to the Supabase Auth URL configuration.

### Deploy to Heroku (container)

Heroku runs the Docker image directly and injects `$PORT` (the app already honors it).

```bash
heroku login
heroku container:login
heroku create your-ftb-backend                 # creates the app + git remote

# set config (never commit these)
heroku config:set NODE_ENV=production \
  SUPABASE_URL=... SUPABASE_PUBLISHABLE_KEY=... SUPABASE_SECRET_KEY=... \
  CORS_ORIGIN=https://your-frontend-domain -a your-ftb-backend

# build, push, and release the container (run from backend/)
heroku container:push web -a your-ftb-backend
heroku container:release web -a your-ftb-backend

heroku open -a your-ftb-backend                # hits the running service
```

Check `https://your-ftb-backend.herokuapp.com/api/v1/health`.

### Deploy to a VPS (Docker)

On a fresh Ubuntu VPS with Docker installed:

```bash
# 1. get the code and enter the backend
git clone <your-repo-url> && cd <repo>/backend

# 2. create the env file with production values
cp .env.example .env && nano .env     # set NODE_ENV=production and real secrets

# 3. build and run, restarting on reboot
docker build -t ftb-backend .
docker run -d --name ftb-backend --restart unless-stopped \
  -p 8080:8080 --env-file .env ftb-backend
```

Then put a reverse proxy (nginx or Caddy) in front for TLS and route your API domain to 127.0.0.1:8080. Example nginx server block:

```nginx
server {
  server_name api.your-domain.com;
  location / { proxy_pass http://127.0.0.1:8080; proxy_set_header Host $host; }
}
```

Use certbot (or Caddy's automatic HTTPS) to add TLS. Alternatively, deploy both apps at once from the repo root with `docker compose up -d --build`.

### A note on Vercel

Vercel targets serverless/static workloads and does not keep a long-lived Fastify process running, so it is not the natural fit for this backend - prefer Heroku, a container host, or a VPS here. If you must use Vercel, you would need to adapt the Fastify app to a serverless function handler; the frontend, by contrast, deploys to Vercel cleanly (see the frontend README).

## Troubleshooting

- Server exits immediately with a config error: a required env var is missing or empty. The message names the key (never the value).
- 401 on every request: the frontend is sending no/expired token, or the Supabase project URL does not match the one that issued the JWT.
- CORS errors in the browser: CORS_ORIGIN must list the frontend's exact origin (scheme + host + port, no trailing slash).
- /api/v1/ready returns 503: the backend cannot reach Supabase - check SUPABASE_URL and network egress.
- `GET`/`PATCH /family` returns 404 without an active membership; `/me` reports NO_ACCESS or REVOKED. Draft product access returns `403 SUBSCRIPTION_REQUIRED`; owners use `/family/onboarding` to resume setup. Login does not create a family.

Member APIs, paginated history and rollout: [specification 03 guide](../docs/implementation/03-member-dashboard-rollout.md). Enable backend `MEMBER_VIEWS_ENABLED` only after migration 008 and staging acceptance.

Stripe backend/worker configuration and staging acceptance: [specification 05 guide](../docs/implementation/05-stripe-billing-rollout.md). Secrets stay server-side; `npm run worker` runs the separate durable billing processor.

Subscription access deployment and recovery: [Specification 06 rollout](../docs/implementation/06-subscription-entitlements-rollout.md).
