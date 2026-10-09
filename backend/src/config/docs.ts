/**
 * OpenAPI documentation wiring (`@fastify/swagger` + `@fastify/swagger-ui`).
 *
 * `registerDocs(app)` is called from `buildApp()` **before** any routes are
 * registered so that every subsequently-added route is captured in the
 * generated OpenAPI document (R27.1, R27.2). It:
 *
 *   1. Registers `@fastify/swagger` in dynamic mode with:
 *        - sensible OpenAPI `info` (title "Family Task Board API", version),
 *        - a reusable `ErrorContract` schema component describing the uniform
 *          `{ error: { code, message } }` error body (R25.1),
 *        - `transform: jsonSchemaTransform` from `fastify-type-provider-zod`,
 *          which converts the Zod `params`/`querystring`/`body`/`response`
 *          schemas attached to each route into JSON Schema so the document
 *          shows real request/response shapes (R27.2),
 *        - `transformObject`, which decorates every documented operation with
 *          the standard Error_Contract responses (401/404/422/500, …) so the
 *          docs show the error contract for every route (R27.2).
 *   2. Registers `@fastify/swagger-ui` serving the browsable UI at `/api/docs`
 *      (R27.1). The UI route is public — it carries no auth hook — so the API
 *      can be browsed without a token.
 */
import type { FastifyInstance } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { jsonSchemaTransform } from 'fastify-type-provider-zod';
import type { OpenAPIV3 } from 'openapi-types';

/** JSON-Schema description of the Error_Contract body `{ error:{code,message} }` (R25.1). */
const ERROR_CONTRACT_SCHEMA = {
  type: 'object',
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      required: ['code', 'message'],
      properties: {
        code: {
          type: 'string',
          description:
            'Stable, machine-readable error code (e.g. UNAUTHORIZED, NOT_FOUND, VALIDATION, FORBIDDEN, TASK_ALREADY_COMPLETED, INSUFFICIENT_POINTS, INTERNAL).',
        },
        message: {
          type: 'string',
          description:
            'Human-readable, client-safe message. Never contains stack traces, SQL text, or secrets (R25.3).',
        },
      },
    },
  },
} as const;

/**
 * The common Error_Contract responses attached to every documented `/api/v1`
 * operation. `UNAUTHORIZED (401)` and `INTERNAL (500)` are implicit on every
 * authenticated route; `422 VALIDATION` and `404 NOT_FOUND` are the common
 * client-facing failures (per the design's REST API table). All reference the
 * shared `ErrorContract` component so the docs render one consistent shape.
 */
const ERROR_RESPONSE_STATUSES: ReadonlyArray<[string, string]> = [
  ['401', 'Unauthorized — missing or invalid Bearer token (UNAUTHORIZED).'],
  ['403', 'Forbidden — ownership or privileged-write guard rejected the request (FORBIDDEN).'],
  ['404', 'Not found — resource missing or belongs to another family (NOT_FOUND).'],
  ['409', 'Conflict — e.g. the task is already completed (TASK_ALREADY_COMPLETED).'],
  ['422', 'Validation failed — request params, query, or body are invalid (VALIDATION / INSUFFICIENT_POINTS).'],
  ['500', 'Internal server error (INTERNAL).'],
];

/** `$ref` pointing at the shared Error_Contract component. */
const ERROR_CONTRACT_REF = '#/components/schemas/ErrorContract';

/**
 * Build the standard set of Error_Contract response entries, each referencing
 * the shared `ErrorContract` schema. Reused for every operation by
 * `transformObject`.
 */
function errorResponses(): Record<string, OpenAPIV3.ResponseObject> {
  const responses: Record<string, OpenAPIV3.ResponseObject> = {};
  for (const [status, description] of ERROR_RESPONSE_STATUSES) {
    responses[status] = {
      description,
      content: {
        'application/json': {
          schema: { $ref: ERROR_CONTRACT_REF },
        },
      },
    };
  }
  return responses;
}

/**
 * Register swagger + swagger-ui. MUST be called before routes are registered so
 * the dynamic generator sees every route (R27.1, R27.2).
 */
export function registerDocs(app: FastifyInstance): void {
  void app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Family Task Board API',
        description:
          'REST API for the Family Task Board backend. All business routes live under `/api/v1` and require a Supabase Bearer JWT; the ops probes (`/api/v1/health`, `/api/v1/ready`) and this documentation are public. Errors use the uniform Error_Contract shape.',
        version: '0.1.0',
      },
      servers: [{ url: '/', description: 'This server' }],
      tags: [
        { name: 'Ops', description: 'Liveness and readiness probes (public).' },
        { name: 'Auth', description: 'Session bootstrap (`/me`).' },
        { name: 'Family', description: 'Household + responsible-user profile.' },
        { name: 'Members', description: 'Family members CRUD + soft delete.' },
        { name: 'Tasks', description: 'Task CRUD, listing/filtering, move, carry-over.' },
        { name: 'Completions', description: 'Atomic task completion and reopen.' },
        { name: 'Templates', description: 'Task templates and recurring generation.' },
        { name: 'Gamification', description: 'Points ledger, leaderboard, awards, redemption.' },
        { name: 'Dashboard', description: 'Home dashboard and weekly board aggregates.' },
      ],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
            description: 'Supabase-issued access token (Google OAuth session).',
          },
        },
        schemas: {
          // Reusable Error_Contract component referenced by every operation's
          // error responses (R25.1, R27.2).
          ErrorContract: ERROR_CONTRACT_SCHEMA as unknown as OpenAPIV3.SchemaObject,
        },
      },
      // Default: routes are authenticated via the Bearer scheme. Individual ops
      // routes override this with an empty security list below.
      security: [{ bearerAuth: [] }],
    },
    // Convert each route's Zod schemas into JSON Schema for the document so
    // params, query, body, and responses are all captured (R27.2).
    transform: jsonSchemaTransform,
    // Decorate every operation with the shared Error_Contract responses, and
    // exempt the public ops probes from the global Bearer security requirement.
    transformObject: (documentObject) => {
      if (!('openapiObject' in documentObject)) {
        return documentObject.swaggerObject;
      }
      const doc = documentObject.openapiObject as OpenAPIV3.Document;
      const paths = doc.paths ?? {};

      for (const [path, pathItem] of Object.entries(paths)) {
        if (!pathItem) continue;
        const isPublicOps =
          path === '/api/v1/health' || path === '/api/v1/ready';

        for (const method of [
          'get',
          'post',
          'patch',
          'put',
          'delete',
        ] as const) {
          const operation = pathItem[method];
          if (!operation) continue;

          // The ops probes need no token — clear the inherited Bearer security.
          if (isPublicOps) {
            operation.security = [];
          }

          // Merge the standard Error_Contract responses in without clobbering
          // the route's own documented success/error responses.
          operation.responses = {
            ...errorResponses(),
            ...(operation.responses ?? {}),
          };
        }
      }

      return doc;
    },
  });

  void app.register(swaggerUi, {
    // Browsable UI at `/api/docs` (R27.1); public so the API can be explored.
    routePrefix: '/api/docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: true,
    },
  });
}
