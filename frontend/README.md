# Family Task Board - Frontend

A React 18 single-page app (Vite + Tailwind + TanStack Query) for the Family Task Board. It authenticates users with Google or optional Supabase email OTP, reads and writes through the typed REST client in `src/api/`, and refreshes authorized data through polling. Highlights: a drag-friendly weekly board, a points leaderboard, award redemption, member profiles, onboarding, and a landscape "Wall Mode" for a mounted display.

> Migration note: this app originally used the Base44 SDK. The data layer was swapped to a typed REST client that talks to this project's backend; the UI stays in `.jsx`. There is no Base44 dependency anymore.

## Tech stack

- React 18, Vite, Tailwind CSS v3 (pinned; v4 moved its PostCSS plugin), Radix UI
- TanStack Query for data fetching/caching
- `@supabase/supabase-js` for provider authentication
- Typed REST client in `src/api/` (`.ts`)
- Vitest + React Testing Library for tests

## User flow

1. The app is gated by `ProtectedRoute`: while the Supabase session resolves it shows a loader, and with no session it redirects to `/login` with validated local returnTo. Google and optional email code choices are available there.
2. On login, `AuthContext` calls `GET /api/v1/me` before rendering family pages to resolve role and access. Resolution never creates a family; unknown and revoked accounts see a dedicated access notice. Resolution repeats on focus and every 30 seconds, clearing cached family data when scope changes.
3. `Layout` sends the user to `/onboarding` until the family is configured (helper `isFamilyConfigured` in `src/lib/familyUtils.js`: both `relationship` and `responsible_name` set). Onboarding submits name + your name + role via `PATCH /family`, then routes to the dashboard. There is no "load sample data" option — the flow is fully manual.
4. From there: Members (CRUD), Board/Dashboard (create, assign, move, complete tasks), Leaderboard, Awards (create + redeem), Templates, History, and Wall Mode.

### Create-payload convention

The backend's create schemas are strict: they reject any field that is server-derived. So the modals send ONLY user-authored fields — never `family_id`, `owner_id`, `created_by_user_id`, `active`, or a task's initial `status`, and optional id/date fields are sent as `null` (not `""`). This is what keeps member/task/template/award creation from failing with `422 VALIDATION`.

## Prerequisites

- Node.js 20+ and npm
- A running backend (see `backend/README.md`) reachable at the URL you set in `VITE_API_URL`
- A Supabase project with Google OAuth enabled, and its Site URL / redirect URIs configured for this app's origin (see the root README's "One-time Supabase setup")

## Run locally (step by step)

```bash
cd frontend
cp .env.example .env     # 1. create your env file
# 2. edit .env:
#    VITE_API_URL=http://localhost:8080
#    VITE_SUPABASE_URL=https://your-project-ref.supabase.co
#    VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_your-key
npm install              # 3. install dependencies
npm run dev               # 4. start Vite on http://localhost:5173
```

Open http://localhost:5173 and sign in with Google. For login to work, the Supabase Auth "Site URL" (and redirect URLs) must include `http://localhost:5173`.

## Environment variables

All frontend variables are build-time (Vite `import.meta.env.VITE_*`) and are baked into the static bundle, so a rebuild is required when they change. Only public values belong here - never put the Supabase secret key in the frontend.

| Variable | Required | Description |
| --- | --- | --- |
| `VITE_API_URL` | yes | Base URL of the backend as seen by the browser (e.g. `http://localhost:8080` or your API domain) |
| `VITE_SUPABASE_URL` | yes | Supabase project URL |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | yes | Supabase publishable (public) key `sb_publishable_...` - safe to ship to the browser |

## npm scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Start the Vite dev server |
| `npm run build` | Produce the static production bundle in `dist/` |
| `npm run preview` | Serve the built bundle locally to sanity-check it |
| `npm test` | Run the Vitest + React Testing Library suite |
| `npm run typecheck` | Type-check the TypeScript data layer (`src/api`) |

## Testing

```bash
npm test
```

Runs the component and hook suites (REST client, auth + `/me` bootstrap, hooks, authorized polling, Wall Mode, onboarding, parity). No backend or network is needed - the api modules and Supabase client are mocked.

## Build and run with Docker

The `Dockerfile` is multi-stage: it runs `vite build` then serves the static files with nginx (non-root) on port 8080. The `VITE_*` values are passed as build args and baked into the bundle.

```bash
docker build \
  --build-arg VITE_API_URL=https://your-api-domain \
  --build-arg VITE_SUPABASE_URL=https://your-project-ref.supabase.co \
  --build-arg VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_your-key \
  -t ftb-frontend ./
docker run --rm -p 5173:8080 ftb-frontend
```

## Deployment

The frontend is static files, so any static host works. Whatever host you pick, set the three `VITE_*` values at build time, and afterward make sure the backend's `CORS_ORIGIN` and the Supabase Auth Site URL / redirect URLs include this app's public origin.

### Deploy to Vercel (recommended for the frontend)

Vercel builds and hosts the static bundle cleanly.

```bash
npm i -g vercel
vercel login
vercel            # first run links/creates the project (set the root to frontend/)
```

In the Vercel dashboard (Project -> Settings -> Environment Variables), add `VITE_API_URL`, `VITE_SUPABASE_URL`, and `VITE_SUPABASE_PUBLISHABLE_KEY`. Vercel auto-detects Vite (build `npm run build`, output `dist`). Then ship production:

```bash
vercel --prod
```

Add your Vercel domain to the Supabase Auth URL configuration and to the backend's `CORS_ORIGIN`.

### Deploy to Heroku (static via the nginx container)

Heroku can run the frontend's nginx container. Because `VITE_*` are baked at build time, pass them as build args when you build the image.

```bash
heroku login && heroku container:login
heroku create your-ftb-frontend

# build with the public config baked in (run from frontend/)
docker build \
  --build-arg VITE_API_URL=https://your-ftb-backend.herokuapp.com \
  --build-arg VITE_SUPABASE_URL=https://your-project-ref.supabase.co \
  --build-arg VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_your-key \
  -t registry.heroku.com/your-ftb-frontend/web .

docker push registry.heroku.com/your-ftb-frontend/web
heroku container:release web -a your-ftb-frontend
```

The nginx config already listens on `$PORT`/8080 and falls back to `index.html` for client-side routes.

### Deploy to a VPS

Two common options:

- Static files behind nginx: build locally (`npm run build`) and copy `dist/` to the server, serving it with an nginx site that falls back to `index.html`.
- Docker: build the image on the server with the `--build-arg` values above and run it with `--restart unless-stopped`, fronted by a TLS reverse proxy.

```bash
git clone <your-repo-url> && cd <repo>/frontend
docker build \
  --build-arg VITE_API_URL=https://api.your-domain.com \
  --build-arg VITE_SUPABASE_URL=https://your-project-ref.supabase.co \
  --build-arg VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_your-key \
  -t ftb-frontend .
docker run -d --name ftb-frontend --restart unless-stopped -p 8080:8080 ftb-frontend
```

Point your domain at the proxy and add TLS (certbot or Caddy). For a static (non-Docker) nginx host, ensure the server block does `try_files $uri /index.html;` so client-side routes resolve.

### Run both apps together

From the repo root, `docker compose up -d --build` builds and runs the backend and frontend together using the root `.env`.

## Troubleshooting

- Login does nothing / redirect error: the Supabase Google provider is off, or this app's origin is missing from the Supabase Auth Site URL / redirect URLs.
- API calls fail with CORS errors: the backend's `CORS_ORIGIN` must include this app's exact origin.
- Calls hit the wrong host, or 404s after refresh: `VITE_API_URL` was wrong at build time (rebuild to change it), or the static host is not falling back to `index.html` for SPA routes.
- Env change had no effect: `VITE_*` are compile-time - rebuild/redeploy after changing them.
- No family access after login: inspect `/me`; NO_ACCESS requires a provisioned verified mailbox, REVOKED requires manager action. New tenant creation is planned in specification 04.
- Create fails with `422 VALIDATION`: the request includes a server-derived field (`family_id`, `owner_id`, `active`, a task's `status`) or an empty string where a uuid/date is expected. Send only user-authored fields; use `null` for empty optionals.

## Email OTP login

Google remains available. Enable `VITE_EMAIL_OTP_ENABLED=true` after configuring Supabase email templates, custom SMTP, six-digit codes and provider-side abuse controls. `VITE_AUTH_CAPTCHA_SITE_KEY` optionally enables the Cloudflare Turnstile widget; its secret belongs in Supabase. These settings are build-time values.

`/login` handles both methods. Protected URLs preserve a validated local destination; no-access, revoked and resolution-error routes provide retry/change-account actions. Logout and API 401 return to neutral login. See the [rollout and recovery guide](../docs/implementation/02-email-otp-rollout.md).

## Member dashboard and history

The backend `member:views` capability enables the personal Home, shared board, own profile/history, rankings, awards catalog and view-only Wall. Owner/Manager retain management screens. All queries and optimistic mutations use the current app-user/family/role/access-version scope. History loads 50 records initially with explicit paging; summary cards use full-range server aggregates. Rankings use the server API, including UTC range labels and competition ranks. See the [member rollout guide](../docs/implementation/03-member-dashboard-rollout.md).
