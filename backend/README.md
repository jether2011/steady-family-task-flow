# Family Task Board - Backend

A Node.js + TypeScript REST API built on Fastify 5, backed by a hosted Supabase (PostgreSQL) project. It verifies Supabase-issued JWTs, resolves each caller's family, and owns all privileged writes - the points ledger runs through atomic PostgreSQL functions invoked with the Supabase service-role key. Reads additionally rely on row-level security.

- Base path: `/api/v1`
- Interactive API docs (OpenAPI): `/api/docs`
- Liveness: `/api/v1/health` - Readiness: `/api/v1/ready`

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
#    SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, CORS_ORIGIN
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
| `SUPABASE_ANON_KEY` | yes | - | Public anon key (user-scoped requests) |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | - | Privileged key for atomic ledger writes. Backend only - never expose. |
| `CORS_ORIGIN` | yes | - | Comma-separated allowed origins, no trailing slash. No wildcard in production. |

`.env` is git-ignored and is never baked into the Docker image.

## npm scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Watch mode via tsx on `src/server.ts` |
| `npm run build` | Compile TypeScript to `dist/` (tsc) |
| `npm start` | Run the compiled server (`node dist/server.js`) |
| `npm test` | Run the Vitest suite |
| `npm run typecheck` | Type-check without emitting |

## Database migrations

The schema lives in `src/supabase/migrations/` as plain SQL, applied in numeric order, plus `src/supabase/seed.sql` for demo data.

| File | Purpose |
| --- | --- |
| `001_initial_schema.sql` | Tables, enums (as TEXT + CHECK), FKs, uniqueness constraints |
| `002_indexes.sql` | Family-scoped indexes + recurring-generation idempotency index |
| `003_rls.sql` | Row-level security policies (ledger writes are service-role only) |
| `004_functions.sql` | Atomic `complete_task` / `reopen_task` / `redeem_award` + `updated_at` trigger |
| `005_realtime.sql` | Adds tables to the `supabase_realtime` publication |
| `006_update_family.sql` | Atomic family/responsible-user update function |
| `seed.sql` | Idempotent demo family data |

Apply them with any of these:

- Dashboard SQL Editor: paste each file in order and run.
- Supabase CLI: `supabase db push` (if you manage migrations via the CLI) or run files with `supabase db execute`.
- psql against the connection string from Project Settings -> Database:

```bash
for f in src/supabase/migrations/0*.sql; do psql "$DATABASE_URL" -f "$f"; done
psql "$DATABASE_URL" -f src/supabase/seed.sql    # optional demo data
```

Migrations and `seed.sql` are idempotent, so re-running them is safe.

## Testing

```bash
npm test
```

By default the database-backed integration and property suites skip gracefully (no database required), so this run is fast and green. To exercise the full suite - including all 14 fast-check correctness properties - point it at a disposable Postgres:

```bash
docker run --rm -d -p 55432:5432 -e POSTGRES_PASSWORD=pg --name ftb-pg postgres:16-alpine
TEST_DATABASE_URL=postgresql://postgres:pg@127.0.0.1:55432/postgres npm test
docker rm -f ftb-pg
```

The DB-backed suites rebuild the schema per run and are serialized (see `vitest.config.ts`) so they do not race on the shared database.

## Build and run with Docker

The `Dockerfile` is multi-stage and runs as a non-root user. No secrets are baked in - config is injected at runtime.

```bash
docker build -t ftb-backend ./        # from the backend/ directory
docker run --rm -p 8080:8080 --env-file .env ftb-backend
```

## Deployment

The backend is a long-running HTTP server, so host it somewhere that keeps a process alive (a container host, Heroku dyno, or VPS). Before deploying anywhere: finish the Supabase setup and apply the migrations, then set the env vars on the host. After the frontend is live, set `CORS_ORIGIN` to the frontend's public origin and add that origin to the Supabase Auth URL configuration.

### Deploy to Heroku (container)

Heroku runs the Docker image directly and injects `$PORT` (the app already honors it).

```bash
heroku login
heroku container:login
heroku create your-ftb-backend                 # creates the app + git remote

# set config (never commit these)
heroku config:set NODE_ENV=production \
  SUPABASE_URL=... SUPABASE_ANON_KEY=... SUPABASE_SERVICE_ROLE_KEY=... \
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
