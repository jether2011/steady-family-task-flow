import { describe, it, expect, vi, afterEach } from 'vitest';
import { configureApiClient, get } from './client';
afterEach(() => vi.unstubAllGlobals());
describe('session-scoped API failures', () => {
  it('reports revocation separately from authentication expiration', async () => {
    const unauthorized = vi.fn(),
      revoked = vi.fn();
    configureApiClient({
      getAccessToken: () => 'session',
      onUnauthorized: unauthorized,
      onAccessRevoked: revoked,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: { code: 'ACCESS_REVOKED', message: 'Revoked' },
            }),
            { status: 403 },
          ),
      ),
    );
    await expect(get('/family')).rejects.toMatchObject({
      code: 'ACCESS_REVOKED',
    });
    expect(revoked).toHaveBeenCalledTimes(1);
    expect(unauthorized).not.toHaveBeenCalled();
  });
  it('ignores an old account unauthorized response after a session transition', async () => {
    let token = 'old';
    const unauthorized = vi.fn();
    configureApiClient({
      getAccessToken: () => token,
      onUnauthorized: unauthorized,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        token = 'new';
        return new Response(
          JSON.stringify({
            error: { code: 'UNAUTHORIZED', message: 'Expired' },
          }),
          { status: 401 },
        );
      }),
    );
    await expect(get('/family')).rejects.toMatchObject({ status: 401 });
    expect(unauthorized).not.toHaveBeenCalled();
  });
});
