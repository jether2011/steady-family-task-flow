# Family Task Board - Frontend

A React 18 single-page app (Vite + Tailwind + TanStack Query) for the Family Task Board. It authenticates users with Supabase Google OAuth, reads and writes through the typed REST client in `src/api/`, and subscribes to Supabase Realtime for live board updates. Highlights: a drag-friendly weekly board, a points leaderboard, award redemption, member profiles, onboarding, and a landscape "Wall Mode" for a mounted display.

> Migration note: this app originally used the Base44 SDK. The data layer was swapped to a typed REST client that talks to this project's backend; the UI stays in `.jsx`. There is no Base44 dependency anymore.

## Tech stack

- React 18, Vite, Tailwind CSS, Radix UI
- TanStack Query for data fetching/caching
- `@supabase/supabase-js` for auth + realtime
- Typed REST client in `src/api/` (`.ts`)
- Vitest + React Testing Library for tests

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
#    VITE_SUPABASE_ANON_KEY=your-anon-key
npm install              # 3. install dependencies
npm run dev               # 4. start Vite on http://localhost:5173
```

Open http://localhost:5173 and sign in with Google. For login to work, the Supabase Auth "Site URL" (and redirect URLs) must include `http://localhost:5173`.

## Environment variables

All frontend variables are build-time (Vite `import.meta.env.VITE_*`) and are baked into the static bundle, so a rebuild is required when they change. Only public values belong here - never put the Supabase service-role key in the frontend.

| Variable | Required | Description |
| --- | --- | --- |
| `VITE_API_URL` | yes | Base URL of the backend as seen by the browser (e.g. `http://localhost:8080` or your API domain) |
| `VITE_SUPABASE_URL` | yes | Supabase project URL |
| `VITE_SUPABASE_ANON_KEY` | yes | Supabase anon (public) key - safe to ship to the browser |

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

Runs the component and hook suites (client/auth/hooks/realtime/Wall Mode/parity). No backend or network is needed - the api modules and Supabase client are mocked.

## Build and run with Docker

The `Dockerfile` is multi-stage: it runs `vite build` then serves the static files with nginx (non-root) on port 8080. The `VITE_*` values are passed as build args and baked into the bundle.

```bash
docker build \
  --build-arg VITE_API_URL=https://your-api-domain \
  --build-arg VITE_SUPABASE_URL=https://your-project-ref.supabase.co \
  --build-arg VITE_SUPABASE_ANON_KEY=your-anon-key \
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

In the Vercel dashboard (Project -> Settings -> Environment Variables), add `VITE_API_URL`, `VITE_SUPABASE_URL`, and `VITE_SUPABASE_ANON_KEY`. Vercel auto-detects Vite (build `npm run build`, output `dist`). Then ship production:

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
  --build-arg VITE_SUPABASE_ANON_KEY=your-anon-key \
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
  --build-arg VITE_SUPABASE_ANON_KEY=your-anon-key \
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
