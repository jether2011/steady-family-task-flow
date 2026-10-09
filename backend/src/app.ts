/**
 * Fastify composition root.
 *
 * `buildApp()` returns a configured Fastify instance with:
 *   - pino structured logging with secret redaction (shared `loggerOptions`, task 3.3)
 *   - the Zod type provider (`fastify-type-provider-zod`) for request/response schemas
 *   - `@fastify/cors`, locked down in production to the `CORS_ORIGIN` allowlist (R29.8)
 *   - the Error_Contract error handler (`registerErrorHandler`, task 3.2)
 *   - a route-registration stub where domain modules will be mounted in later tasks
 *
 * Business routes, auth, and context middleware are intentionally absent — this is
 * the skeleton the rest of the backend is assembled onto.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import cors, { type FastifyCorsOptions } from '@fastify/cors';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';

// `src/config/env.ts` (task 1.2) exports a validated, frozen `env` with `PORT`,
// `NODE_ENV`, `CORS_ORIGIN`, and a pre-parsed `corsOrigins` allowlist (R29.8).
import { env } from './config/env.js';
// `src/config/logger.ts` (task 3.3) exports the shared pino options with the
// secret-redaction policy and env-derived level (R26.1).
import { loggerOptions } from './config/logger.js';
// `src/config/docs.ts` (task 12.1) registers `@fastify/swagger` +
// `@fastify/swagger-ui`. Called BEFORE routes so the dynamic generator captures
// every `/api/v1` route (params/body/response + Error_Contract) and serves the
// browsable UI at `/api/docs` (R27.1, R27.2).
import { registerDocs } from './config/docs.js';
// `src/modules/ops/ops.routes.ts` (task 12.1) registers the UNAUTHENTICATED
// liveness/readiness probes `GET /api/v1/health` and `GET /api/v1/ready`
// (R26.2–R26.4). Mounted outside the authenticated `/api/v1` scope.
import { opsRoutes } from './modules/ops/ops.routes.js';
// `src/middleware/error-handler.ts` (task 3.2) wires the Error_Contract handler:
// AppError subclasses + Zod/validation errors → { error: { code, message } },
// unknown errors → generic INTERNAL 500 with internals stripped (R25.1–R25.3).
import { registerErrorHandler } from './middleware/error-handler.js';
// `src/middleware/authentication.ts` (task 4.1) verifies the Supabase Bearer JWT
// (JWKS) and attaches the verified `sub` to `request.authUserId` (R1.2/R1.3/R1.7).
import { registerAuthentication } from './middleware/authentication.js';
// `src/middleware/context.ts` (task 4.1) resolves auth.uid() → responsible_user →
// family and attaches `request.ctx` (R23.2); it never creates the family.
import { registerContext } from './middleware/context.js';
// `src/modules/auth/auth.routes.ts` (task 4.2) registers `GET /me`, the first-
// login bootstrap that creates exactly one family per responsible user (R1.4).
import { authRoutes } from './modules/auth/auth.routes.js';
// `src/modules/family/family.routes.ts` (task 5.1) registers `GET`/`PATCH
// /api/v1/family`: the composed family DTO read and the two-table atomic update
// (R2.1–R2.4).
import { familyRoutes } from './modules/family/family.routes.js';
// `src/modules/members/member.routes.ts` (task 5.2) registers the members CRUD +
// soft-delete routes under `/api/v1/family/members` (R3.1–R3.6).
import { memberRoutes } from './modules/members/member.routes.js';
// `src/modules/tasks/task.routes.ts` (task 6.1) registers the task CRUD routes:
// `POST /api/v1/family/tasks`, `PATCH`/`DELETE /api/v1/tasks/:id` (R4.1–R4.7,
// R5.1–R5.2). Task 6.2 extends the same module (listing/filtering + move)
// without further `app.ts` wiring.
import { taskRoutes } from './modules/tasks/task.routes.js';
// `src/modules/completions/completion.routes.ts` (task 7.1) registers the
// atomic completion route `POST /api/v1/tasks/:id/complete`: ownership + member
// checks in code (404/403/422/409) then the service-role `complete_task` RPC
// (R8.1–R8.8, R9.2–R9.3, R10.2–R10.6, R23.6).
import { completionRoutes } from './modules/completions/completion.routes.js';
// `src/modules/templates/template.routes.ts` (task 9.1) registers the task-
// template CRUD routes: `GET`/`POST /api/v1/family/task-templates`,
// `PATCH`/`DELETE /api/v1/task-templates/:id` (DELETE deactivates → 204). The
// CUSTOM recurrence rule requires `recurrence_config.days` of ints 0..6 else
// `422` (R12.1–R12.5). Task 9.2 extends the same module with the recurring-
// generation endpoint without further `app.ts` wiring.
import { templateRoutes } from './modules/templates/template.routes.js';
// `src/modules/gamification/gamification.routes.ts` (task 10.1) registers the
// ledger-read + leaderboard routes: `GET /api/v1/family/points` (optionally
// filtered by memberId/from/to → `{ transactions }`), `GET
// /api/v1/family/leaderboard` (ranked active-member totals summed from the
// ledger; invalid `period` → 422), and `GET
// /api/v1/family/members/:id/completions` (`{ completions, transactions }`;
// foreign/missing id → 404) (R10.1, R15.1–R15.5). Task 10.2 extends the same
// module with awards CRUD + redeem without further `app.ts` wiring.
import { gamificationRoutes } from './modules/gamification/gamification.routes.js';
// `src/modules/dashboard/dashboard.routes.ts` (task 11.1) registers the
// aggregate home view + weekly board: `GET /api/v1/family/dashboard`
// (`{ family, members(active), todayTasks, totals }` with totals summed from
// the ledger) and `GET /api/v1/family/board?weekStart`
// (`{ weekStart, tasks, byDay, byStatus }`; missing/malformed `weekStart` →
// 422). Both are family-scoped (R16.1–R16.3, R17.1–R17.3).
import { dashboardRoutes } from './modules/dashboard/dashboard.routes.js';

/**
 * The slice of config CORS resolution depends on. Declared as a parameter so
 * {@link resolveCorsOrigin} can be unit-tested with injected values (R29.8)
 * without mutating the frozen singleton `env`; production callers rely on the
 * default and get the real `env`.
 */
export interface CorsConfig {
  readonly NODE_ENV: string;
  readonly corsOrigins: readonly string[];
}

/**
 * Resolve the `@fastify/cors` `origin` option from configuration.
 *
 * In `production` the origin is the explicit `corsOrigins` allowlist (parsed from
 * `CORS_ORIGIN`), with any wildcard `*` stripped so it is never emitted (R29.8).
 * Outside production we reflect the request origin to keep local development frictionless.
 *
 * Exported (with an injectable `config`, defaulting to the frozen `env`) solely
 * so the security suite can assert the wildcard-stripping behaviour directly.
 */
export function resolveCorsOrigin(config: CorsConfig = env): string[] | boolean {
  if (config.NODE_ENV === 'production') {
    return config.corsOrigins.filter((origin) => origin !== '*');
  }
  // Development/test: reflect the caller's origin rather than opening a wildcard.
  return true;
}

export function buildApp(): FastifyInstance {
  const app = Fastify({
    // Shared pino options: env-derived level plus the `redact` policy that keeps
    // Authorization headers, tokens, Service_Role_Key values, cookies, and
    // credential-bearing bodies out of every request/error log line (R26.1).
    logger: loggerOptions,
  }).withTypeProvider<ZodTypeProvider>();

  // Validate/serialize request & response schemas with Zod.
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // CORS — restricted to the allowlist in production, never `*` (R29.8).
  const corsOptions: FastifyCorsOptions = {
    origin: resolveCorsOrigin(),
    credentials: true,
  };
  void app.register(cors, corsOptions);

  // OpenAPI docs (task 12.1). Registered BEFORE routes so the dynamic swagger
  // generator captures every subsequently-registered `/api/v1` route — request
  // params/query/body and response schemas (via the Zod→JSON-Schema transform)
  // plus the shared Error_Contract responses — and serves the browsable UI at
  // `/api/docs`, publicly (R27.1, R27.2).
  registerDocs(app);

  // Ops probes (task 12.1): `GET /api/v1/health` (liveness) and
  // `GET /api/v1/ready` (readiness — 200 when Supabase is reachable, else 503).
  // Mounted at the `/api/v1` prefix but OUTSIDE the authenticated scope below,
  // so neither carries an auth hook: deployment probes never send a Bearer
  // token (R26.2–R26.4). This replaces the earlier placeholder root `/health`.
  void app.register(
    (ops, _opts, done) => {
      opsRoutes(ops);
      done();
    },
    { prefix: '/api/v1' },
  );

  // Route-registration: mounts the authenticated `/api/v1` domain scope.
  registerRoutes(app);

  // Error_Contract handling (task 3.2): maps AppError subclasses and Zod/schema
  // validation failures to { error: { code, message } } with the right HTTP
  // status, routes unmatched paths to 404 NOT_FOUND, and returns a generic
  // INTERNAL 500 for anything unexpected without leaking stack traces, SQL, or
  // secrets (R25.1–R25.3). Registered last so it wraps all routes.
  registerErrorHandler(app);

  return app;
}

/**
 * Mounting point for domain route plugins.
 *
 * All authenticated business routes live under the encapsulated `/api/v1` scope
 * registered here. That scope applies, in order, the authentication hook
 * (verify Supabase JWT → `request.authUserId`) and the context resolver
 * (`request.ctx = { userId, responsibleUserId, familyId }`), so every route
 * mounted inside it runs behind the full identity pipeline (R1.2/R1.3/R1.7,
 * R23.2). Public probes (`/api/v1/health`, `/api/v1/ready`) and the docs UI
 * (`/api/docs`) are registered OUTSIDE this scope — in `buildApp()` above — so
 * they stay unauthenticated.
 *
 * Domain module plugins (auth/`me`, family, members, tasks, completions,
 * gamification, dashboard) are registered inside `apiV1` in later tasks:
 *   void apiV1.register(familyRoutes);
 */
function registerRoutes(app: FastifyInstance): void {
  void app.register(
    (apiV1, _opts, done) => {
      // Encapsulated scope: hooks added here apply only to routes registered on
      // `apiV1` (and its children), never to the public ops/docs probes mounted
      // separately in `buildApp()`.
      registerAuthentication(apiV1); // preHandler: verify JWT → request.authUserId
      registerContext(apiV1); //        preHandler: resolve → request.ctx

      // Auth / bootstrap: `GET /api/v1/me` (task 4.2). Mounted here so it runs
      // behind the identity pipeline; it deliberately does NOT require an
      // already-bootstrapped family and creates one on first login (R1.4).
      authRoutes(apiV1);

      // Family: `GET`/`PATCH /api/v1/family` (task 5.1). Reads the composed
      // family DTO and routes a flat partial update to `families` +
      // `responsible_users` atomically (R2.1–R2.4).
      familyRoutes(apiV1);

      // Members: `GET`/`POST /api/v1/family/members` and
      // `PATCH`/`DELETE /api/v1/family/members/:id` (task 5.2). CRUD with soft
      // delete (DELETE sets active=false, retains the row) and IDOR → 404
      // (R3.1–R3.6).
      memberRoutes(apiV1);

      // Tasks: `POST /api/v1/family/tasks`, `PATCH`/`DELETE /api/v1/tasks/:id`
      // (task 6.1). CRUD with server-derived identity; `.strict()` rejects a
      // client-supplied status/family_id (R4.2), a non-family assignee → 422
      // (R4.7), and a foreign/missing id → 404 (R5.2). Task 6.2 adds
      // listing/filtering + move to this same module without changing app.ts.
      taskRoutes(apiV1);

      // Completions: `POST /api/v1/tasks/:id/complete` (task 7.1) and
      // `POST /api/v1/tasks/:id/reopen` (task 7.2). Complete runs the ordered
      // ownership/validation checks (foreign task → 404, member not in family →
      // 403, inactive member → 422, already DONE → 409) then the atomic
      // `complete_task` RPC; reopen checks ownership (404) and non-DONE (422)
      // then the atomic `reopen_task` RPC, which removes the completion, keeps
      // the original ledger row, appends the REVERSAL, and sets TODO
      // (R8.1–R8.8, R9.2–R9.3, R10.2–R10.6, R11.1–R11.8, R11.10, R23.6).
      completionRoutes(apiV1);

      // Task-templates: `GET`/`POST /api/v1/family/task-templates` and
      // `PATCH`/`DELETE /api/v1/task-templates/:id` (task 9.1). CRUD where
      // DELETE deactivates (sets active=false, retains the row for historical
      // Task references) and answers `204`; a foreign/missing id → `404`. The
      // CUSTOM `recurrence_type` requires `recurrence_config.days` of integers
      // 0..6 else `422` (R12.1–R12.5). Task 9.2 adds the recurring-generation
      // endpoint to this same module without changing app.ts.
      templateRoutes(apiV1);

      // Gamification: `GET /api/v1/family/points`,
      // `GET /api/v1/family/leaderboard`, and
      // `GET /api/v1/family/members/:id/completions` (task 10.1). Ledger reads
      // + leaderboard math ported from `familyUtils.computeLeaderboard`: totals
      // and completed-task counts summed from the Points_Ledger over a UTC
      // period, active members only, ranked points desc then completedTasks
      // desc; an invalid `period` → `422` (R10.1, R15.1–R15.5). Task 10.2 adds
      // awards CRUD + redeem to this same module without changing app.ts.
      gamificationRoutes(apiV1);

      // Dashboard & board: `GET /api/v1/family/dashboard` and
      // `GET /api/v1/family/board?weekStart` (task 11.1). The dashboard returns
      // the composed family, active members, today's (UTC) tasks, and per-member
      // point totals summed from the Points_Ledger; the board returns the
      // selected week's tasks bucketed by day and by status. Both are strictly
      // family-scoped; a missing/malformed `weekStart` → `422`
      // (R16.1–R16.3, R17.1–R17.3).
      dashboardRoutes(apiV1);

      // Further domain routes are registered here by later tasks.
      // The scope is valid and active, so the pipeline is ready.

      done();
    },
    { prefix: '/api/v1' },
  );
}
