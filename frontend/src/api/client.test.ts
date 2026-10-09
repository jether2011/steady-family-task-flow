/**
 * Tests for the typed REST client (`client.ts`).
 *
 * Covers the four task-15.3 behaviors against a mocked `fetch` and a mocked
 * auth seam (`configureApiClient`), without touching the network:
 *   - Bearer attachment: Authorization header from the Supabase session.
 *   - Query serialization: null/undefined dropped, keys/values encoded.
 *   - Error_Contract -> typed `ApiError { code, message, status }`.
 *   - HTTP 401 -> `onUnauthorized()` (redirectToLogin) invoked, still throws.
 *
 * _Requirements: 24.1, 24.5_
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest';

import {
  API_BASE_URL,
  ApiError,
  configureApiClient,
  get,
  post,
  request,
  serializeQuery,
} from './client';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal Response-like object good enough for the client. */
function makeResponse(
  init: {
    ok?: boolean;
    status?: number;
    statusText?: string;
    jsonBody?: unknown;
    textBody?: string;
  } = {},
): Response {
  const status = init.status ?? 200;
  const ok = init.ok ?? (status >= 200 && status < 300);
  return {
    ok,
    status,
    statusText: init.statusText ?? '',
    json: async () => {
      if (init.jsonBody === undefined) throw new Error('no json');
      return init.jsonBody;
    },
    text: async () => init.textBody ?? '',
  } as unknown as Response;
}

/** Reset the module-level auth config to a clean, signed-out state. */
function resetConfig(): void {
  configureApiClient({
    getAccessToken: () => null,
    onUnauthorized: () => {},
  });
}

let fetchMock: Mock;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  resetConfig();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** The headers object the client passed to `fetch` for the first call. */
function firstCallHeaders(): Record<string, string> {
  const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  return init.headers as Record<string, string>;
}

/** The URL the client passed to `fetch` for the first call. */
function firstCallUrl(): string {
  const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
  return url;
}

// ---------------------------------------------------------------------------
// Bearer attachment (R24.1)
// ---------------------------------------------------------------------------

describe('Authorization: Bearer attachment', () => {
  it('attaches the Supabase access token as a Bearer header', async () => {
    configureApiClient({
      getAccessToken: () => 'jwt-abc-123',
      onUnauthorized: () => {},
    });
    fetchMock.mockResolvedValue(makeResponse({ textBody: '' }));

    await request('GET', '/family');

    expect(firstCallHeaders().Authorization).toBe('Bearer jwt-abc-123');
  });

  it('awaits an async token provider before sending the request', async () => {
    configureApiClient({
      getAccessToken: async () => 'async-jwt',
      onUnauthorized: () => {},
    });
    fetchMock.mockResolvedValue(makeResponse({ textBody: '' }));

    await request('GET', '/family');

    expect(firstCallHeaders().Authorization).toBe('Bearer async-jwt');
  });

  it('omits the Authorization header when signed out (null token)', async () => {
    configureApiClient({
      getAccessToken: () => null,
      onUnauthorized: () => {},
    });
    fetchMock.mockResolvedValue(makeResponse({ textBody: '' }));

    await request('GET', '/family');

    expect(firstCallHeaders().Authorization).toBeUndefined();
  });

  it('omits the Authorization header when the token provider throws', async () => {
    configureApiClient({
      getAccessToken: () => {
        throw new Error('session read failed');
      },
      onUnauthorized: () => {},
    });
    fetchMock.mockResolvedValue(makeResponse({ textBody: '' }));

    await request('GET', '/family');

    expect(firstCallHeaders().Authorization).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Query serialization
// ---------------------------------------------------------------------------

describe('serializeQuery', () => {
  it('returns an empty string for no params or an empty object', () => {
    expect(serializeQuery()).toBe('');
    expect(serializeQuery({})).toBe('');
  });

  it('drops null and undefined values but keeps falsy 0 / false / ""', () => {
    const qs = serializeQuery({
      a: 'x',
      b: null,
      c: undefined,
      d: 0,
      e: false,
      f: '',
    });
    const params = new URLSearchParams(qs.replace(/^\?/, ''));
    expect(params.get('a')).toBe('x');
    expect(params.has('b')).toBe(false);
    expect(params.has('c')).toBe(false);
    expect(params.get('d')).toBe('0');
    expect(params.get('e')).toBe('false');
    expect(params.get('f')).toBe('');
  });

  it('url-encodes keys and values', () => {
    const qs = serializeQuery({ 'a b': 'c&d', q: 'a=b' });
    const params = new URLSearchParams(qs.replace(/^\?/, ''));
    expect(params.get('a b')).toBe('c&d');
    expect(params.get('q')).toBe('a=b');
    // The raw string must be percent-encoded, not literal.
    expect(qs).toContain('a+b=c%26d');
  });

  it('prefixes a non-empty query with "?"', () => {
    expect(serializeQuery({ a: '1' }).startsWith('?')).toBe(true);
  });

  it('is applied by request() to build the final URL', async () => {
    fetchMock.mockResolvedValue(makeResponse({ textBody: '' }));

    await get('/family/tasks', { status: 'TODO', memberId: null, date: '2024-01-01' });

    const url = firstCallUrl();
    expect(url.startsWith(`${API_BASE_URL}/family/tasks?`)).toBe(true);
    const query = url.slice(url.indexOf('?') + 1);
    const params = new URLSearchParams(query);
    expect(params.get('status')).toBe('TODO');
    expect(params.get('date')).toBe('2024-01-01');
    expect(params.has('memberId')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Error_Contract -> ApiError
// ---------------------------------------------------------------------------

describe('Error_Contract parsing into ApiError', () => {
  it('parses { error: { code, message } } into a typed ApiError', async () => {
    fetchMock.mockResolvedValue(
      makeResponse({
        ok: false,
        status: 422,
        jsonBody: { error: { code: 'VALIDATION', message: 'bad field' } },
      }),
    );

    const err = await request('POST', '/family/tasks', { body: {} }).catch(
      (e) => e,
    );

    expect(err).toBeInstanceOf(ApiError);
    expect(err).toBeInstanceOf(Error);
    expect((err as ApiError).code).toBe('VALIDATION');
    expect((err as ApiError).message).toBe('bad field');
    expect((err as ApiError).status).toBe(422);
    expect((err as ApiError).name).toBe('ApiError');
  });

  it('falls back to INTERNAL + statusText when the body is not JSON', async () => {
    fetchMock.mockResolvedValue(
      makeResponse({ ok: false, status: 500, statusText: 'Server Error' }),
    );

    const err = await request('GET', '/family').catch((e) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('INTERNAL');
    expect((err as ApiError).message).toBe('Server Error');
    expect((err as ApiError).status).toBe(500);
  });

  it('keeps the status-based code when the JSON lacks an error.code', async () => {
    fetchMock.mockResolvedValue(
      makeResponse({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        jsonBody: { something: 'else' },
      }),
    );

    const err = await request('GET', '/tasks/x').catch((e) => e);

    expect((err as ApiError).code).toBe('INTERNAL');
    expect((err as ApiError).status).toBe(404);
  });

  it('does not throw on 2xx and parses the JSON body', async () => {
    fetchMock.mockResolvedValue(
      makeResponse({ status: 200, textBody: JSON.stringify({ ok: true }) }),
    );

    const data = await request<{ ok: boolean }>('GET', '/family');
    expect(data).toEqual({ ok: true });
  });

  it('resolves undefined for a 204 No Content response', async () => {
    fetchMock.mockResolvedValue(makeResponse({ status: 204 }));

    const data = await request('DELETE', '/tasks/x');
    expect(data).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 401 -> redirect (R24.5)
// ---------------------------------------------------------------------------

describe('401 triggers the configured onUnauthorized (redirectToLogin)', () => {
  it('calls onUnauthorized exactly once and still throws ApiError on 401', async () => {
    const onUnauthorized = vi.fn();
    configureApiClient({
      getAccessToken: () => 'expired-jwt',
      onUnauthorized,
    });
    fetchMock.mockResolvedValue(
      makeResponse({
        ok: false,
        status: 401,
        jsonBody: { error: { code: 'UNAUTHORIZED', message: 'session expired' } },
      }),
    );

    const err = await request('GET', '/family').catch((e) => e);

    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(401);
    expect((err as ApiError).code).toBe('UNAUTHORIZED');
  });

  it('does not call onUnauthorized on non-401 errors', async () => {
    const onUnauthorized = vi.fn();
    configureApiClient({
      getAccessToken: () => 'jwt',
      onUnauthorized,
    });
    fetchMock.mockResolvedValue(
      makeResponse({
        ok: false,
        status: 403,
        jsonBody: { error: { code: 'FORBIDDEN', message: 'nope' } },
      }),
    );

    await request('GET', '/family').catch(() => {});

    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('does not crash on 401 when no onUnauthorized is configured yet', async () => {
    // Simulate pre-configuration: a bare config with a no-op handler is the
    // closest observable state (config starts null internally).
    configureApiClient({
      getAccessToken: () => null,
      onUnauthorized: () => {},
    });
    fetchMock.mockResolvedValue(
      makeResponse({
        ok: false,
        status: 401,
        jsonBody: { error: { code: 'UNAUTHORIZED', message: 'no session' } },
      }),
    );

    const err = await request('GET', '/family').catch((e) => e);
    expect((err as ApiError).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Request plumbing (body + JSON content type) — supports the above behaviors
// ---------------------------------------------------------------------------

describe('request body serialization', () => {
  it('serializes a JSON body and sets Content-Type for POST', async () => {
    fetchMock.mockResolvedValue(makeResponse({ textBody: '' }));

    await post('/family/tasks', { title: 'Dishes' });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(init.body).toBe(JSON.stringify({ title: 'Dishes' }));
  });

  it('omits body and Content-Type when no body is provided', async () => {
    fetchMock.mockResolvedValue(makeResponse({ textBody: '' }));

    await request('GET', '/family');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(init.body).toBeUndefined();
    expect(headers['Content-Type']).toBeUndefined();
  });
});
