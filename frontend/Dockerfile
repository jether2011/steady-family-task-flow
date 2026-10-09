# syntax=docker/dockerfile:1

# =============================================================================
# Frontend Dockerfile — multi-stage Vite build -> static nginx serve (R29.2)
#
# VITE_* values are BUILD-TIME (R29.7): they are passed as build args, set as
# ENV for `vite build`, and baked into the static bundle. The anon key is a
# public client key and is safe to bake; the privileged service-role key is
# NEVER passed to the frontend build or image (R23.5 / R29.4).
#
# The runtime image serves the static files via nginx on port 8080 as the
# unprivileged `nginx` user.
# =============================================================================

# --- build stage -------------------------------------------------------------
FROM node:20-alpine AS build
WORKDIR /app

# Build-time configuration (baked into the bundle). Only public values here.
ARG VITE_API_URL
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_ANON_KEY
ENV VITE_API_URL=$VITE_API_URL \
    VITE_SUPABASE_URL=$VITE_SUPABASE_URL \
    VITE_SUPABASE_ANON_KEY=$VITE_SUPABASE_ANON_KEY

# Install dependencies first for better layer caching.
COPY package*.json ./
RUN npm ci

# Copy sources and produce the static bundle.
COPY . .
RUN npm run build          # vite build -> dist/

# --- runtime stage -----------------------------------------------------------
FROM nginx:alpine AS runtime

# SPA server config: listen on 8080, fall back to index.html for client routes.
# Remove the stock default so our config is the only server block.
RUN rm -f /etc/nginx/conf.d/default.conf
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Serve the compiled static assets.
COPY --from=build /app/dist /usr/share/nginx/html

# Run nginx as the unprivileged `nginx` user (R29.2). Point the pid file at a
# writable location and grant that user the directories nginx needs to write.
RUN sed -i 's|pid        /var/run/nginx.pid;|pid        /tmp/nginx.pid;|' /etc/nginx/nginx.conf \
    && chown -R nginx:nginx /usr/share/nginx/html /var/cache/nginx /var/log/nginx \
    && touch /tmp/nginx.pid \
    && chown nginx:nginx /tmp/nginx.pid

USER nginx

EXPOSE 8080

CMD ["nginx", "-g", "daemon off;"]
