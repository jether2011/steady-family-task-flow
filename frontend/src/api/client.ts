/**
 * Typed REST client for the Family Task Board backend (`/api/v1`).
 *
 * Responsibilities (design: "REST client + per-domain modules"):
 *  - Base URL = `VITE_API_URL` + `/api/v1`.
 *  - Attach `Authorization: Bearer <access_token>` from the current Supabase
 *    session on every request.
 *  - Parse the backend Error_Contract (`{ error: { code, message } }`) on any
 *    non-2xx response and throw a typed `ApiError { code, message, status }`.
 *  - Serialize query params (dropping null/undefined) for list/filter endpoints.
 *  - On a `401`, invoke the configured `onUnauthorized()` (redirect to Google
 *    OAuth login) and still throw `ApiError` so callers can react (R24.5).
 *
 * ---------------------------------------------------------------------------
 * INJECTABLE AUTH CONTRACT (for task 16.1 — AuthContext Supabase rework)
 * ---------------------------------------------------------------------------
 * This module intentionally does NOT import `AuthContext` (that rework is a
 * separate, parallel task). Instead it exposes `configureApiClient(...)`, a
 * one-time setter that the reworked `AuthContext.jsx` must call once the
 * Supabase client exists:
 *
 *   configureApiClient({
 *     // Return the current Supabase access token (JWT) or null if signed out.
 *     // e.g. `(await supabase.auth.getSession()).data.session?.access_token ?? null`
 *     getAccessToken: () => string | null | Promise<string | null>,
 *     // Redirect to the Google OAuth login flow. Called by the 401 handler.
 *     // e.g. `() => supabase.auth.signInWithOAuth({ provider: 'google' })`
 *     onUnauthorized: () => void,
 *   });
 *
 * Until `configureApiClient` is called, requests are sent without an
 * Authorization header (the backend will answer 401), and a 401 is a no-op
 * beyond throwing `ApiError`. Task 15.2's per-domain modules call the exported
 * `request` / HTTP helpers below; they never touch auth directly.
 */

import type { TaskFilter, PointsFilter } from './types';

// ---------------------------------------------------------------------------
// Environment (minimal typing so this .ts stays self-contained)
// ---------------------------------------------------------------------------

interface ImportMetaEnvLike {
  VITE_API_URL?: string;
}

function readApiBaseUrl(): string {
  const env = (import.meta as unknown as { env?: ImportMetaEnvLike }).env;
  const root = env?.VITE_API_URL ?? '';
  // Trim a trailing slash so we don't produce `//api/v1`.
  const trimmed = root.replace(/\/+$/, '');
  return `${trimmed}/api/v1`;
}

/** Resolved base URL: `VITE_API_URL` + `/api/v1`. */
export const API_BASE_URL: string = readApiBaseUrl();

// ---------------------------------------------------------------------------
// Typed error
// ---------------------------------------------------------------------------

/** The Error_Contract shape returned by the backend on any error response. */
export interface ErrorContract {
  error: { code: string; message: string };
}

/**
 * A typed API error thrown for every non-2xx response. Carries the backend
 * Error_Contract `code`/`message` plus the HTTP `status`.
 */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    // Restore prototype chain for instanceof across transpile targets.
    Object.setPrototypeOf(this, ApiError.prototype);
  }
}

// ---------------------------------------------------------------------------
// Injectable auth configuration
// ---------------------------------------------------------------------------

export interface ApiClientConfig {
  /** Return the current Supabase access token, or null when signed out. */
  getAccessToken: () => string | null | Promise<string | null>;
  /** Redirect to the Google OAuth login flow (invoked on a 401). */
  onUnauthorized: () => void;
}

let config: ApiClientConfig | null = null;

/**
 * Wire up the token provider and 401 redirect. Called once by the reworked
 * AuthContext (task 16.1). Safe to call again to replace the configuration.
 */
export function configureApiClient(next: ApiClientConfig): void {
  config = next;
}

// ---------------------------------------------------------------------------
// Query-string serialization
// ---------------------------------------------------------------------------

/** Values accepted in a query object. null/undefined are dropped. */
export type QueryValue = string | number | boolean | null | undefined;
export type QueryParams = Record<string, QueryValue>;

/**
 * Serialize a params object into a query string (leading `?`), dropping
 * null/undefined and URL-encoding keys and values. Returns '' when empty.
 */
export function serializeQuery(params?: QueryParams): string {
  if (!params) return '';
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined) continue;
    search.append(key, String(value));
  }
  const qs = search.toString();
  return qs ? `?${qs}` : '';
}

// ---------------------------------------------------------------------------
// Core request
// ---------------------------------------------------------------------------

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export interface RequestOptions {
  /** JSON body; serialized and sent with `Content-Type: application/json`. */
  body?: unknown;
  /** Query params appended to the path (null/undefined dropped). */
  query?: QueryParams;
  /** Extra headers merged over the defaults. */
  headers?: Record<string, string>;
  /** Optional AbortSignal for cancellation (e.g. TanStack Query). */
  signal?: AbortSignal;
}

async function resolveAccessToken(): Promise<string | null> {
  if (!config) return null;
  try {
    return await config.getAccessToken();
  } catch {
    return null;
  }
}

async function parseErrorContract(res: Response): Promise<ApiError> {
  let code = 'INTERNAL';
  let message = res.statusText || 'Request failed';
  try {
    const data = (await res.json()) as Partial<ErrorContract>;
    if (data && data.error && typeof data.error.code === 'string') {
      code = data.error.code;
      message = data.error.message ?? message;
    }
  } catch {
    // Non-JSON or empty error body: keep the status-based defaults.
  }
  return new ApiError(code, message, res.status);
}

/**
 * Perform a request against the backend. Attaches the bearer token, serializes
 * the JSON body and query string, parses the Error_Contract on failure, and
 * triggers the configured 401 redirect.
 *
 * @typeParam T - the expected (already-parsed) response type.
 * @returns the parsed JSON body, or `undefined` for 204 / empty responses.
 */
export async function request<T>(
  method: HttpMethod,
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const { body, query, headers: extraHeaders, signal } = options;

  const url = `${API_BASE_URL}${path}${serializeQuery(query)}`;

  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...extraHeaders,
  };

  const token = await resolveAccessToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const init: RequestInit = { method, headers, signal };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  const res = await fetch(url, init);

  if (!res.ok) {
    const err = await parseErrorContract(res);
    if (res.status === 401) {
      // Session expired / missing: redirect to login, then still throw so the
      // caller (and TanStack Query) sees the failure (R24.5).
      config?.onUnauthorized();
    }
    throw err;
  }

  // 204 No Content (and other empty bodies) resolve to undefined.
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

// ---------------------------------------------------------------------------
// Convenience HTTP verbs (used by the per-domain modules in task 15.2)
// ---------------------------------------------------------------------------

export function get<T>(
  path: string,
  query?: QueryParams,
  signal?: AbortSignal,
): Promise<T> {
  return request<T>('GET', path, { query, signal });
}

export function post<T>(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  return request<T>('POST', path, { body, signal });
}

export function patch<T>(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  return request<T>('PATCH', path, { body, signal });
}

export function del<T = void>(path: string, signal?: AbortSignal): Promise<T> {
  return request<T>('DELETE', path, { signal });
}

/**
 * Re-exported filter types so per-domain modules can import query shapes from a
 * single place alongside the request helpers.
 */
export type { TaskFilter, PointsFilter };
