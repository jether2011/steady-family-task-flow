/**
 * Unit tests for the Error_Contract middleware (task 3.4).
 *
 * These assert that every error reaching `errorHandler` is rendered as the
 * uniform contract `{ error: { code, message } }` with the authoritative HTTP
 * status (R25.1, R25.2), that validation failures never echo the submitted
 * value (R25.3), and that unexpected errors are logged in full server-side but
 * return only a generic INTERNAL body with no internals leaked (R25.3).
 *
 * `errorHandler` only depends on `../shared/errors` (no env/DB), so it can be
 * driven directly with a mock reply (status()/send() spies) and a mock request
 * (log.error spy) — no Fastify instance or network needed.
 */
import { describe, expect, it, vi } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ZodError, z } from 'zod';

import {
  errorHandler,
  notFoundHandler,
} from '../../src/middleware/error-handler.js';
import {
  Conflict,
  Forbidden,
  InsufficientPoints,
  NotFound,
  Unauthorized,
  ValidationError,
} from '../../src/shared/errors/index.js';

/** A Fastify-style reply whose status()/send() are spies and chain fluently. */
interface MockReply {
  status: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
}

function makeReply(): MockReply {
  const reply = {
    status: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
  } as MockReply;
  return reply;
}

/** A minimal request carrying a log.error spy, cast to the Fastify type. */
function makeRequest(): { log: { error: ReturnType<typeof vi.fn> } } {
  return { log: { error: vi.fn() } };
}

/** Read the single status/body the handler produced. */
function captured(reply: MockReply): { status: number; body: unknown } {
  expect(reply.status).toHaveBeenCalledTimes(1);
  expect(reply.send).toHaveBeenCalledTimes(1);
  return {
    status: reply.status.mock.calls[0][0] as number,
    body: reply.send.mock.calls[0][0],
  };
}

describe('errorHandler — AppError subclasses map to the contract', () => {
  const cases = [
    { name: 'Unauthorized', error: new Unauthorized(), status: 401, code: 'UNAUTHORIZED' },
    { name: 'Forbidden', error: new Forbidden(), status: 403, code: 'FORBIDDEN' },
    { name: 'NotFound', error: new NotFound(), status: 404, code: 'NOT_FOUND' },
    { name: 'ValidationError', error: new ValidationError(), status: 422, code: 'VALIDATION' },
    { name: 'Conflict', error: new Conflict(), status: 409, code: 'TASK_ALREADY_COMPLETED' },
    { name: 'InsufficientPoints', error: new InsufficientPoints(), status: 422, code: 'INSUFFICIENT_POINTS' },
  ] as const;

  for (const { name, error, status, code } of cases) {
    it(`${name} → ${status} ${code}`, () => {
      const reply = makeReply();
      const request = makeRequest();

      errorHandler(
        error,
        request as unknown as FastifyRequest,
        reply as unknown as FastifyReply,
      );

      const { status: gotStatus, body } = captured(reply);
      expect(gotStatus).toBe(status);
      expect(body).toEqual({ error: { code, message: error.message } });
      // The handler recognised a known error, so nothing is logged as unhandled.
      expect(request.log.error).not.toHaveBeenCalled();
    });
  }

  it('renders only { code, message } under error (no extra internals)', () => {
    const reply = makeReply();
    const request = makeRequest();

    errorHandler(
      new Forbidden('Cross-family access denied'),
      request as unknown as FastifyRequest,
      reply as unknown as FastifyReply,
    );

    const { body } = captured(reply);
    expect(Object.keys(body as object)).toEqual(['error']);
    const inner = (body as { error: Record<string, unknown> }).error;
    expect(Object.keys(inner).sort()).toEqual(['code', 'message']);
  });
});

describe('errorHandler — validation failures (R25.3: value never leaked)', () => {
  // A recognisable secret-looking value we feed into a bad request body. If it
  // ever appears in the response message, the no-leak guarantee is broken.
  const SUBMITTED_SECRET = 'super-secret-token-should-not-leak-42';

  it('raw ZodError → 422 VALIDATION with field path but not the value', () => {
    const schema = z.object({ points: z.number() });
    let zodError: ZodError;
    try {
      // Pass the secret where a number is required to force a ZodError.
      schema.parse({ points: SUBMITTED_SECRET });
      throw new Error('expected parse to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ZodError);
      zodError = err as ZodError;
    }

    const reply = makeReply();
    const request = makeRequest();
    errorHandler(
      zodError,
      request as unknown as FastifyRequest,
      reply as unknown as FastifyReply,
    );

    const { status, body } = captured(reply);
    expect(status).toBe(422);
    const inner = (body as { error: { code: string; message: string } }).error;
    expect(inner.code).toBe('VALIDATION');
    // The message may name the field path...
    expect(inner.message).toContain('points');
    // ...but must NOT echo the submitted value.
    expect(inner.message).not.toContain(SUBMITTED_SECRET);
  });

  it('Fastify-style error with a .validation array → 422 VALIDATION, value absent', () => {
    // Shape produced by Fastify's own (non-Zod) schema validation.
    const fastifyError = {
      validation: [
        {
          instancePath: '/body/password',
          message: 'must be string',
          // A realistic Fastify entry can carry the rejected value in params;
          // the handler must never read or surface it.
          params: { rejectedValue: SUBMITTED_SECRET },
        },
      ],
    };

    const reply = makeReply();
    const request = makeRequest();
    errorHandler(
      fastifyError,
      request as unknown as FastifyRequest,
      reply as unknown as FastifyReply,
    );

    const { status, body } = captured(reply);
    expect(status).toBe(422);
    const inner = (body as { error: { code: string; message: string } }).error;
    expect(inner.code).toBe('VALIDATION');
    expect(inner.message).toContain('body/password');
    expect(inner.message).not.toContain(SUBMITTED_SECRET);
    // A validation failure is expected input, not an unhandled server error.
    expect(request.log.error).not.toHaveBeenCalled();
  });
});

describe('errorHandler — unknown errors become a generic INTERNAL 500', () => {
  it('logs the full error server-side but leaks nothing to the client', () => {
    // An error whose message/stack carry internals that must stay server-side.
    const internal = new Error(
      'ECONNREFUSED select * from users where password = \'hunter2\'',
    );
    internal.stack =
      'Error: db failure\n    at Query.run (/app/node_modules/pg/lib/query.js:42:11)';

    const reply = makeReply();
    const request = makeRequest();
    errorHandler(
      internal,
      request as unknown as FastifyRequest,
      reply as unknown as FastifyReply,
    );

    const { status, body } = captured(reply);
    expect(status).toBe(500);
    expect(body).toEqual({
      error: { code: 'INTERNAL', message: 'Internal Server Error' },
    });

    // Full detail IS logged server-side (so operators can debug).
    expect(request.log.error).toHaveBeenCalledTimes(1);
    const [logPayload] = request.log.error.mock.calls[0];
    expect(logPayload).toEqual({ err: internal });

    // The response body carries no stack / SQL / secret material.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toContain('select *');
    expect(serialized).not.toContain('node_modules');
    expect(serialized).not.toContain('ECONNREFUSED');
  });

  it('a thrown non-Error value still yields the INTERNAL contract', () => {
    const reply = makeReply();
    const request = makeRequest();
    errorHandler(
      'raw string blew up',
      request as unknown as FastifyRequest,
      reply as unknown as FastifyReply,
    );

    const { status, body } = captured(reply);
    expect(status).toBe(500);
    expect(body).toEqual({
      error: { code: 'INTERNAL', message: 'Internal Server Error' },
    });
    expect(request.log.error).toHaveBeenCalledTimes(1);
  });
});

describe('notFoundHandler — unmatched routes share the contract', () => {
  it('→ 404 NOT_FOUND', () => {
    const reply = makeReply();
    notFoundHandler(
      {} as unknown as FastifyRequest,
      reply as unknown as FastifyReply,
    );

    const { status, body } = captured(reply);
    expect(status).toBe(404);
    const inner = (body as { error: { code: string; message: string } }).error;
    expect(inner.code).toBe('NOT_FOUND');
    expect(typeof inner.message).toBe('string');
    expect(inner.message.length).toBeGreaterThan(0);
  });
});
