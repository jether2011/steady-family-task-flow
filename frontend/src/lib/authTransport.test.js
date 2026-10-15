import { describe, it, expect, vi, afterEach } from 'vitest';
import { authFetch, readOtpBackoff } from './authTransport';
afterEach(() => vi.unstubAllGlobals());
describe('provider Retry-After handling', () => {
  it('retains longer numeric backoff without modifying the provider response', async () => {
    const response = new Response('{}', {
      status: 429,
      headers: { 'Retry-After': '120' },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response),
    );
    const started = Date.now();
    expect(await authFetch('https://project.test/auth/v1/otp', {})).toBe(
      response,
    );
    expect(readOtpBackoff(started)).toBe(120);
  });
  it('supports HTTP-date values and maintains the minimum cooldown', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('{}', {
            status: 429,
            headers: {
              'Retry-After': new Date(Date.now() + 180000).toUTCString(),
            },
          }),
      ),
    );
    const started = Date.now();
    await authFetch('https://project.test/auth/v1/otp', {});
    expect(readOtpBackoff(started)).toBeGreaterThan(170);
  });
});
