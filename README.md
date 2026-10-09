# Family Task Board

A full-stack family chore and reward board. Parents create tasks, assign them to family members, and the app tracks completions, awards points, maintains a leaderboard, and lets members redeem rewards. It includes a landscape "Wall Mode" for a mounted kitchen display and real-time updates across devices.

The project is split into two independently deployable apps:

| App | Stack | What it does |
| --- | --- | --- |
| `backend/` | Node 20 - Fastify 5 - TypeScript - Supabase (PostgreSQL) | REST API, atomic points ledger, auth verification, OpenAPI docs |
| `frontend/` | React 18 - Vite - Tailwind - TanStack Query | SPA UI, Supabase Google OAuth, real-time board, Wall Mode |

Both talk to a hosted Supabase project, which provides the PostgreSQL database, authentication (Google OAuth), row-level security, and real-time subscriptions.

---

## Architecture at a glance

```
          +--------------+     Bearer JWT      +--------------+
Browser ->|   frontend   | ------------------> |   backend    |
          | (React SPA)  |   REST /api/v1      |  (Fastify)   |
          +------+-------+                     +------+-------+
                 | Google OAuth + realtime            | service-role
                 | (anon key)                         | (privileged)
                 v                                    v
          +---------------------------------------------------+
          |                     Supabase                      |
          |   PostgreSQL . Auth (Google) . RLS . Realtime     |
          +---------------------------------------------------+
```

- The frontend signs users in with Supabase Google OAuth and sends the resulting JWT as a Bearer token to the backend. It subscribes to Supabase Realtime for live board updates.
- The backend verifies the JWT against Supabase's JWKS, resolves the caller's family, and performs all privileged writes (the points ledger uses atomic PostgreSQL functions) using the Supabase service-role key. Row-level security is a second isolation guarantee for reads.

---

## Prerequisites

- Node.js 20+ and npm
- Docker + Docker Compose (optional, for the one-command local run)
- A Supabase project - see the manual setup below. This is the one piece that cannot live in the repo.

---

## One-time Supabase setup (required before the app works)

Everything the apps need in code is in this repo, but a Supabase project must be created in the Supabase dashboard (a web console). This produces the secrets both apps read from env and enables Google login. Do this once:

1. Create the project. Sign in at [supabase.com](https://supabase.com), create a new project, and wait for it to provision.
2. Grab the keys. In the dashboard, go to Project Settings -> API and copy:
   - Project URL -> used as `SUPABASE_URL` / `VITE_SUPABASE_URL`
   - anon public key -> `SUPABASE_ANON_KEY` / `VITE_SUPABASE_ANON_KEY` (safe to expose to the browser)
   - service_role key -> `SUPABASE_SERVICE_ROLE_KEY` (secret - backend only, never ship to the browser or commit it)
3. Enable Google OAuth. Go to Authentication -> Providers -> Google, toggle it on, and paste a Google OAuth Client ID and Client Secret (created in the [Google Cloud Console](https://console.cloud.google.com/) under APIs & Services -> Credentials -> OAuth client ID -> Web application). In the Google credential, add Supabase's callback URL (`https://<your-project-ref>.supabase.co/auth/v1/callback`) as an authorized redirect URI. In Authentication -> URL Configuration, set the Site URL to your frontend origin (e.g. `http://localhost:5173` for local dev).
4. Apply the database schema. Run the SQL migrations and seed in order. The simplest path is the dashboard SQL Editor: open each file under `backend/src/supabase/migrations/` in numeric order (001 -> 006) and run it, then optionally run `backend/src/supabase/seed.sql` for demo data. The backend README also shows how to apply them with psql or the Supabase CLI.

> Why this is manual: creating the project, flipping the Google provider on, and supplying Google's OAuth credentials are account/console/third-party actions. The migrations, API, and auth wiring are all already in code.

---

## Quick start (local, with Docker Compose)

The fastest way to run both apps together:

```bash
cp .env.example .env     # then fill in your Supabase values
docker compose up --build
```

- Frontend: http://localhost:5173
- Backend: http://localhost:8080 (health check at /api/v1/health, API docs at /api/docs)

The root `.env` supplies both the backend runtime env and the frontend build args. See `.env.example` for every variable.

## Quick start (local, without Docker)

Run each app in its own terminal. Full details are in each app's README.

```bash
# Terminal 1 - backend
cd backend
cp .env.example .env      # fill in Supabase values
npm install
npm run dev               # http://localhost:8080

# Terminal 2 - frontend
cd frontend
cp .env.example .env      # fill in Supabase values + VITE_API_URL=http://localhost:8080
npm install
npm run dev               # http://localhost:5173
```

---

## Environment variables

| Variable | Used by | Secret? | Notes |
| --- | --- | --- | --- |
| `SUPABASE_URL` | backend | no | Project URL |
| `SUPABASE_ANON_KEY` | backend | no | Public anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | backend | yes | Privileged; backend only |
| `CORS_ORIGIN` | backend | no | Allowed frontend origin(s); no wildcard in production |
| `PORT` / `NODE_ENV` | backend | no | Defaults to 8080 / development |
| `VITE_API_URL` | frontend | no | Backend base URL as seen by the browser |
| `VITE_SUPABASE_URL` | frontend | no | Project URL |
| `VITE_SUPABASE_ANON_KEY` | frontend | no | Public anon key, baked into the bundle |

The `VITE_*` values are build-time for the frontend (baked into the static bundle), so a rebuild is required whenever they change.

---

## Testing

```bash
cd backend  && npm test   # Fastify suites + 14 fast-check property tests (DB suites skip without TEST_DATABASE_URL)
cd frontend && npm test   # Vitest + React Testing Library
```

The backend's database-backed suites skip gracefully unless you point `TEST_DATABASE_URL` at a disposable Postgres. See the backend README for running the full suite against a real database.

---

## Deployment

Each app ships its own Dockerfile and can be deployed independently. Step-by-step guides for Vercel, Heroku, and a VPS are in each app's README:

- Backend deployment: see `backend/README.md`
- Frontend deployment: see `frontend/README.md`

Deploy order that avoids a chicken-and-egg problem:

1. Finish the Supabase setup and apply migrations.
2. Deploy the backend, note its public URL.
3. Deploy the frontend with `VITE_API_URL` pointing at that backend URL.
4. Update the backend's `CORS_ORIGIN` and the Supabase Site URL / redirect URIs to the frontend's public origin.

---

## Project layout

```
.
+- backend/              # Fastify + TypeScript REST API over Supabase
|  +- src/
|  |  +- modules/        # auth, family, members, tasks, completions, templates, gamification, dashboard, ops
|  |  +- middleware/     # auth, context, authorization, error handling
|  |  +- config/         # env, supabase clients, logger, docs
|  |  +- supabase/       # SQL migrations 001-006 + seed.sql
|  +- Dockerfile
+- frontend/             # React SPA (data-layer migrated off Base44 to a typed REST client)
|  +- src/
|  |  +- api/            # typed REST client + per-domain api modules (.ts)
|  |  +- hooks/          # TanStack Query hooks + realtime
|  |  +- pages/          # Board, Wall Mode, leaderboard, awards, profiles, onboarding
|  |  +- lib/            # Supabase client + AuthContext
|  +- nginx.conf
|  +- Dockerfile
+- docker-compose.yml    # runs both apps together
+- .env.example          # root env for compose
```

---

## License

See LICENSE.
