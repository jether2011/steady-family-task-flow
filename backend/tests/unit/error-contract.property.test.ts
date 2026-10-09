/**
 * Property test for the Error_Contract (task 3.5 — Property 12).
 *
 * **Feature: family-task-board-backend, Property 12: Every error response
 * matches the Error_Contract**
 *
 * **Validates: Requirements 25.1, 25.2, 25.3**
 *
 * The error-handler middleware (`src/middleware/error-handler.ts`) is the single
 * place where any thrown value becomes the uniform contract
 * `{ error: { code: string, message: string } }` (R25.1), with the HTTP status
 * derived from the authoritative code↔HTTP mapping (R25.2), and with internals
 * (stack traces, SQL text, secrets) never reaching the client (R25.3).
 *
 * This property drives the handler with an arbitrary that mixes every error
 * shape it can receive — each {@link AppError} subclass, a raw `ZodError`, a
 * Fastify validation-shaped error, and arbitrary unknown `Error`s whose messages
 * may contain fake "stack"/SQL/secret text — and asserts, for ANY of them:
 *   • `reply.status` was called with the number the mapping requires;
 *   • `reply.send` received an object of EXACTLY the shape
 *     `{ error: { code: nonempty string, message: string } }`;
 *   • for the UNKNOWN-error case the message is the fixed generic string, so no
 *     injected stack/SQL/secret can leak (R25.3);
 *   • for AppError cases the `code` equals the subclass's own code (R25.2).
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { ZodError, z } from 'zod';

import { errorHandler } from '../../src/middleware/error-handler.js';
import {
  AppError,
  Conflict,
  Forbidden,
  InsufficientPoints,
  NotFound,
  Unauthorized,
  ValidationError,
} from '../../src/shared/errors/index.js';

/** The three recognised buckets, used to compute the expected status/code. */
type Expectation =
  | { kind: 'app'; status: number; code: string }
  | { kind: 'validation' } // Zod + Fastify-validation-shaped → 422 VALIDATION
  | { kind: 'unknown' }; // everything else → 500 INTERNAL (generic message)

interface Generated {
  error: unknown;
  expect: Expectation;
}

/** The fixed generic message the handler returns for unknown errors (R25.3). */
const GENERIC_MESSAGE = 'Internal Server Error';

/**
 * Strings that must NEVER appear in a message returned for an unknown error.
 * These are injected into the unknown-error messages so a leak would be caught.
 */
const LEAK_MARKERS = ['SELECT * FROM', 'service_role', 'at Object.<anonymous>'];

/** A minimal `reply` double that records the status + sent body. */
function makeReply() {
  const calls: { status?: number; body?: unknown } = {};
  const reply = {
    status(code: number) {
      calls.status = code;
      return reply;
    },
    send(body: unknown) {
      calls.body = body;
      return reply;
    },
  };
  // The handler only ever touches `status` and `send`; cast through unknown so
  // we don't have to stub the whole FastifyReply surface.
  return { reply: reply as unknown as Parameters<typeof errorHandler>[2], calls };
}

/** A minimal `request` double exposing just the `log.error` the handler uses. */
function makeRequest() {
  return {
    log: { error: () => undefined },
  } as unknown as Parameters<typeof errorHandler>[1];
}

/** Arbitrary over every AppError subclass, paired with its expected mapping. */
const appErrorArb: fc.Arbitrary<Generated> = fc.oneof(
  fc.constant<Generated>({
    error: new Unauthorized(),
    expect: { kind: 'app', status: 401, code: 'UNAUTHORIZED' },
  }),
  fc.string().map<Generated>((m) => ({
    error: new Forbidden(m),
    expect: { kind: 'app', status: 403, code: 'FORBIDDEN' },
  })),
  fc.string().map<Generated>((m) => ({
    error: new NotFound(m),
    expect: { kind: 'app', status: 404, code: 'NOT_FOUND' },
  })),
  fc.string().map<Generated>((m) => ({
    error: new ValidationError(m),
    expect: { kind: 'app', status: 422, code: 'VALIDATION' },
  })),
  fc.constant<Generated>({
    error: new Conflict(),
    expect: { kind: 'app', status: 409, code: 'TASK_ALREADY_COMPLETED' },
  }),
  fc.constant<Generated>({
    error: new InsufficientPoints(),
    expect: { kind: 'app', status: 422, code: 'INSUFFICIENT_POINTS' },
  }),
);

/** A raw ZodError produced by failing a tiny schema against random bad input. */
const zodErrorArb: fc.Arbitrary<Generated> = fc
  .record({
    points: fc.oneof(fc.string(), fc.boolean(), fc.constant(null)),
    name: fc.oneof(fc.integer(), fc.constant(undefined)),
  })
  .map<Generated>((bad) => {
    const schema = z.object({ points: z.number(), name: z.string() });
    const result = schema.safeParse(bad);
    // By construction `bad` never satisfies the schema, so this is always a
    // ZodError; fall back defensively just in case fast-check shrinks oddly.
    const error = result.success
      ? new ZodError([])
      : (result.error as ZodError);
    return { error, expect: { kind: 'validation' } };
  });

/**
 * A Fastify-validation-shaped error: a plain object carrying a `validation`
 * array of `{ instancePath }` entries (the shape Fastify/`fastify-type-provider-zod`
 * attaches). The handler normalises this to 422 VALIDATION.
 */
const fastifyValidationArb: fc.Arbitrary<Generated> = fc
  .array(
    fc.record({
      instancePath: fc.oneof(
        fc.constant('/body/points'),
        fc.constant('/body/name'),
        fc.constant(''),
        fc.string().map((s) => `/${s}`),
      ),
    }),
    { minLength: 1, maxLength: 4 },
  )
  .map<Generated>((validation) => {
    const err = Object.assign(new Error('schema validation failed'), {
      validation,
      statusCode: 400,
    });
    return { error: err, expect: { kind: 'validation' } };
  });

/**
 * Arbitrary unknown errors whose messages may embed fake stack/SQL/secret text.
 * These must become the generic INTERNAL 500 with no leakage (R25.3). We also
 * mix in non-Error throwables (strings, numbers, null) since the handler must
 * cope with anything.
 */
const unknownErrorArb: fc.Arbitrary<Generated> = fc.oneof(
  // Random Error with a message that may contain leak markers + arbitrary text.
  fc
    .record({
      prefix: fc.string(),
      marker: fc.oneof(...LEAK_MARKERS.map((m) => fc.constant(m)), fc.string()),
      suffix: fc.string(),
    })
    .map<Generated>(({ prefix, marker, suffix }) => {
      const err = new Error(`${prefix} ${marker} ${suffix}`);
      // Give it a realistic-looking stack containing a leak marker too.
      err.stack = `Error: ${marker}\n    at Object.<anonymous> (/app/db.ts:42:13)`;
      return { error: err, expect: { kind: 'unknown' } };
    }),
  // A DB-style error object (not an AppError, no `validation`) with SQL text.
  fc.string().map<Generated>((table) => {
    const err = Object.assign(new Error(`SELECT * FROM ${table}`), {
      code: '42P01',
      detail: 'service_role key leaked here',
    });
    return { error: err, expect: { kind: 'unknown' } };
  }),
  // Non-Error throwables.
  fc.string().map<Generated>((s) => ({ error: s, expect: { kind: 'unknown' } })),
  fc.integer().map<Generated>((n) => ({ error: n, expect: { kind: 'unknown' } })),
  fc.constant<Generated>({ error: null, expect: { kind: 'unknown' } }),
  fc.constant<Generated>({ error: undefined, expect: { kind: 'unknown' } }),
);

/** The full error space the handler may receive. */
const anyErrorArb: fc.Arbitrary<Generated> = fc.oneof(
  appErrorArb,
  zodErrorArb,
  fastifyValidationArb,
  unknownErrorArb,
);

/**
 * Assert the recorded body is EXACTLY `{ error: { code, message } }` with the
 * right primitive types and no extra keys at either level, then return it typed.
 */
function assertContractShape(body: unknown): { code: string; message: string } {
  expect(body).toBeTypeOf('object');
  expect(body).not.toBeNull();
  const outer = body as Record<string, unknown>;
  expect(Object.keys(outer)).toEqual(['error']);

  const inner = outer.error as Record<string, unknown>;
  expect(inner).toBeTypeOf('object');
  expect(inner).not.toBeNull();
  // Exactly { code, message } — order-independent, no extra fields.
  expect(new Set(Object.keys(inner))).toEqual(new Set(['code', 'message']));

  expect(inner.code).toBeTypeOf('string');
  expect((inner.code as string).length).toBeGreaterThan(0);
  expect(inner.message).toBeTypeOf('string');

  return { code: inner.code as string, message: inner.message as string };
}

describe('Feature: family-task-board-backend, Property 12: Every error response matches the Error_Contract', () => {
  it('maps any error to the Error_Contract with the correct status and no leaked internals', () => {
    fc.assert(
      fc.property(anyErrorArb, ({ error, expect: exp }) => {
        const { reply, calls } = makeReply();
        const request = makeRequest();

        errorHandler(error, request, reply);

        // A status and a body were always produced (R25.1).
        expect(calls.status).toBeTypeOf('number');
        const { code, message } = assertContractShape(calls.body);

        if (exp.kind === 'app') {
          // AppError → its own http status and code (R25.2).
          expect(calls.status).toBe(exp.status);
          expect(code).toBe(exp.code);
          // The error being an AppError is a precondition of this branch.
          expect(error).toBeInstanceOf(AppError);
        } else if (exp.kind === 'validation') {
          // Zod / Fastify-validation-shaped → 422 VALIDATION (R25.2).
          expect(calls.status).toBe(422);
          expect(code).toBe('VALIDATION');
        } else {
          // Unknown → generic 500 INTERNAL with the fixed message (R25.3):
          // nothing from the thrown error (stack/SQL/secret) may leak.
          expect(calls.status).toBe(500);
          expect(code).toBe('INTERNAL');
          expect(message).toBe(GENERIC_MESSAGE);
          for (const marker of LEAK_MARKERS) {
            expect(message).not.toContain(marker);
          }
        }
      }),
      { numRuns: 200 },
    );
  });
});
