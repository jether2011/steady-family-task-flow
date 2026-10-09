/**
 * Shared application errors.
 *
 * Every error that should surface to the client as a predictable
 * Error_Contract (`{ error: { code, message } }`, R25.1) is an {@link AppError}
 * subclass carrying `{ code, http, message }`. The error-handler middleware
 * (task 3.2) catches these, maps them to the HTTP status in `http`, and emits
 * the contract body; any other thrown value becomes a generic `INTERNAL` 500
 * (R25.3) so stack traces, SQL text, and secrets never leak.
 *
 * The code ↔ HTTP mapping here is the authoritative one from the design's
 * "Code ↔ HTTP mapping" table and R25.2:
 *   UNAUTHORIZED → 401, FORBIDDEN → 403, NOT_FOUND → 404,
 *   VALIDATION → 422, TASK_ALREADY_COMPLETED → 409, INSUFFICIENT_POINTS → 422.
 */

/**
 * Base class for all client-facing errors.
 *
 * Carries the Error_Contract `code`, the `http` status the handler should use,
 * and a human-readable `message` (safe to return to the client — must never
 * contain stack traces, SQL, or secrets, per R25.3).
 */
export class AppError extends Error {
  constructor(
    public readonly code: string,
    public readonly http: number,
    message: string,
  ) {
    super(message);
    // Preserve the concrete subclass name (e.g. `NotFound`) for logs/instanceof.
    this.name = new.target.name;
  }
}

/** Missing or invalid authentication → `401 UNAUTHORIZED` (R25.2). */
export class Unauthorized extends AppError {
  constructor() {
    super('UNAUTHORIZED', 401, 'Authentication required');
  }
}

/** Cross-family or otherwise forbidden action → `403 FORBIDDEN` (R25.2, R23.6). */
export class Forbidden extends AppError {
  constructor(message = 'Forbidden') {
    super('FORBIDDEN', 403, message);
  }
}

/** Missing or foreign (IDOR) resource → `404 NOT_FOUND` (R25.2, R23.3). */
export class NotFound extends AppError {
  constructor(message = 'Resource not found') {
    super('NOT_FOUND', 404, message);
  }
}

/** Request failed validation → `422 VALIDATION` (R25.2). */
export class ValidationError extends AppError {
  constructor(message = 'Invalid request') {
    super('VALIDATION', 422, message);
  }
}

/** Completing an already-DONE task → `409 TASK_ALREADY_COMPLETED` (R9.x, R25.2). */
export class Conflict extends AppError {
  constructor() {
    super('TASK_ALREADY_COMPLETED', 409, 'This task has already been completed.');
  }
}

/** Redemption would drive the derived balance below 0 → `422 INSUFFICIENT_POINTS` (R18.x). */
export class InsufficientPoints extends AppError {
  constructor() {
    super('INSUFFICIENT_POINTS', 422, 'Insufficient points for this redemption.');
  }
}
