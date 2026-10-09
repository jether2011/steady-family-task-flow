# syntax=docker/dockerfile:1

# =============================================================================
# Backend Dockerfile — multi-stage, non-root (R29.1)
#
# build stage:   compile TypeScript -> dist/ with `npm run build` (tsc).
# runtime stage: install production deps only and run `node dist/server.js`
#                as the unprivileged built-in `node` user.
# No secrets are copied or baked; all config is injected at runtime via the
# environment (see docker-compose.yml and backend/.env.example).
# =============================================================================

# --- build stage -------------------------------------------------------------
FROM node:20-alpine AS build
WORKDIR /app

# Install all dependencies (incl. devDependencies) for the TypeScript build.
COPY package*.json ./
RUN npm ci

# Copy sources and compile. `.dockerignore` keeps node_modules/dist/.env out.
COPY . .
RUN npm run build          # tsc -p tsconfig.json -> dist/

# --- runtime stage -----------------------------------------------------------
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Install production dependencies only — smaller, no build tooling in runtime.
COPY package*.json ./
RUN npm ci --omit=dev

# Bring over just the compiled output from the build stage.
COPY --from=build /app/dist ./dist

# Drop privileges: the official node image ships an unprivileged `node` user.
USER node

# The server listens on 0.0.0.0:PORT (PORT defaults to 8080 in env.ts).
EXPOSE 8080

# Lightweight liveness probe against the public health route (task 12.1).
# Uses Node's global fetch (Node 20+) so no extra tooling is required.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
