/**
 * Error-handler middleware — the single place where thrown errors become the
 * uniform Error_Contract `{ "error": { "code": string, "message": string } }`
 * (R25.1).
 *
 * It classifies every error reaching Fastify into one of three buckets and never
 * lets internals escape to the client (R25.3 — no stack traces, SQL text, or
 * secret values in any `message`):
 *
 *   1. {@link AppError} subclasses → their own `http` status and
 *      `{ code, message }`. These messages are authored to be client-safe
 *      (R25.2 — the authoritative code↔HTTP mapping lives on the classes).
 *   2. Zod / Fastify schema-validation failures → `422 VALIDATION` with a
 *      generic message that may name the offending field path but never echoes
 *      the submitted value (so secrets in a bad body can't leak).
 *   3. Anything else (unexpected errors, DB/SQL failures, response-serialization
 *      errors, bugs) → logged server-side in full, returned as a generic
 *      `500 INTERNAL` with a fixed message.
 *
 * `registerErrorHandler(app)` wires both `setErrorHandler` and
 * `setNotFoundHandler` (unmatched routes → `404 NOT_FOUND`) so the 404 shape
 * matches the contract too.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';
import { ZodError } from 'zod';

import { AppError } from '../shared/errors/index.js';

/** The Error_Contract body shape (R25.1). */
interface ErrorContract {
  error: {
    code: string;
    message: string;
  };
}

/** Build the Error_Contract envelope from a code and a client-safe message. */
function contract(code: string, message: string): ErrorContract {
  return { error: { code, message } };
}

/**
 * Produce a client-safe VALIDATION message.
 *
 * We may say *which* field failed (helps the frontend), but we deliberately
 * never include the rejected value — a bad request body could contain a token
 * or password, and echoing it back would leak a secret (R25.3).
 */
function validationMessage(fieldPath: string | undefined): string {
  if (fieldPath && fieldPath.length > 0) {
    return `Validation failed for '${fieldPath}'.`;
  }
  return 'Invalid request.';
}

/**
 * Extract the first offending field path from a Zod schema-validation error
 * carried on `error.validation` (populated by `fastify-type-provider-zod`).
 * Returns the dotted path (e.g. `body/points`) or `undefined` when unavailable.
 * Only the path is read — never the value.
 */
function firstValidationPath(validation: ReadonlyArray<{ instancePath?: string }>): string | undefined {
  const first = validation[0];
  if (first && typeof first.instancePath === 'string') {
    // instancePath looks like `/body/points`; trim the leading slash for brevity.
    const trimmed = first.instancePath.replace(/^\//, '');
    return trimmed.length > 0 ? trimmed : undefined;
  }
  return undefined;
}

/** First field path from a raw Zod error's issues, if any (value never read). */
function firstZodIssuePath(error: ZodError): string | undefined {
  const first = error.issues[0];
  if (first && first.path.length > 0) {
    return first.path.join('/');
  }
  return undefined;
}

/**
 * The Fastify error handler. Exported for unit testing; registered via
 * {@link registerErrorHandler} in production.
 */
export function errorHandler(
  error: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  // 1. Known client-facing errors carry their own code + HTTP status (R25.2).
  if (error instanceof AppError) {
    void reply.status(error.http).send(contract(error.code, error.message));
    return;
  }

  // 2. Zod request validation via fastify-type-provider-zod. The library tags
  //    each entry on `error.validation`; map to 422 VALIDATION (R25.2) with a
  //    field-only message.
  if (hasZodFastifySchemaValidationErrors(error)) {
    const path = firstValidationPath(error.validation);
    void reply.status(422).send(contract('VALIDATION', validationMessage(path)));
    return;
  }

  // 2b. A raw ZodError (e.g. a service parsing input directly) → same contract.
  if (error instanceof ZodError) {
    const path = firstZodIssuePath(error);
    void reply.status(422).send(contract('VALIDATION', validationMessage(path)));
    return;
  }

  // 2c. Fastify's own (non-Zod) schema validation also surfaces as a 400 with a
  //     `validation` array. Normalise it to the contract's 422 VALIDATION so the
  //     client sees one validation code regardless of which validator ran.
  if (
    typeof error === 'object' &&
    error !== null &&
    'validation' in error &&
    Array.isArray((error as { validation: unknown }).validation)
  ) {
    const validation = (error as { validation: ReadonlyArray<{ instancePath?: string }> }).validation;
    void reply.status(422).send(contract('VALIDATION', validationMessage(firstValidationPath(validation))));
    return;
  }

  // 3. Anything else is unexpected. Log the full error server-side (stack, cause,
  //    any DB/SQL text) for debugging, but return only a generic INTERNAL body so
  //    internals never reach the client (R25.3).
  request.log.error({ err: error }, 'Unhandled error — returning INTERNAL');
  void reply.status(500).send(contract('INTERNAL', 'Internal Server Error'));
}

/**
 * Handler for routes Fastify can't match. Returns the contract's `404 NOT_FOUND`
 * so unknown paths share the uniform error shape (R25.1/R25.2).
 */
export function notFoundHandler(_request: FastifyRequest, reply: FastifyReply): void {
  void reply.status(404).send(contract('NOT_FOUND', 'Resource not found'));
}

/**
 * Wire the Error_Contract handlers into a Fastify instance. Call once from the
 * composition root (`buildApp`) after routes are registered.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler(notFoundHandler);
}
