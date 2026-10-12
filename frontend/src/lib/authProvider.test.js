import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ request: vi.fn(), verify: vi.fn() }));
vi.mock('./supabaseClient', () => ({
  supabase: { auth: { signInWithOtp: mocks.request, verifyOtp: mocks.verify } },
}));
let provider;
beforeEach(async () => {
  vi.resetModules();
  vi.stubEnv('VITE_EMAIL_OTP_ENABLED', 'true');
  vi.stubEnv('VITE_AUTH_CAPTCHA_SITE_KEY', '');
  mocks.request.mockReset();
  mocks.verify.mockReset();
  provider = await import('./authProvider');
});
afterEach(() => vi.unstubAllEnvs());
describe('Supabase email OTP contract', () => {
  it('normalizes email and permits a new provider account, without custom roles', async () => {
    mocks.request.mockResolvedValue({
      data: { user: null, session: null },
      error: null,
    });
    expect(await provider.requestCode(' Person+tag@Example.test ')).toEqual({
      email: 'person+tag@example.test',
      retryAfter: 60,
    });
    expect(mocks.request).toHaveBeenCalledWith({
      email: 'person+tag@example.test',
      options: { shouldCreateUser: true },
    });
  });
  it('verifies six digits using email type', async () => {
    const session = { user: { id: 'subject' } };
    mocks.verify.mockResolvedValue({ data: { session }, error: null });
    expect(await provider.verifyCode('Person@Example.test', '012345')).toBe(
      session,
    );
    expect(mocks.verify).toHaveBeenCalledWith({
      email: 'person@example.test',
      token: '012345',
      type: 'email',
    });
  });
  it.each(['12', '12345x', '1234567'])(
    'rejects invalid code %s without provider call',
    async (code) => {
      await expect(
        provider.verifyCode('person@example.test', code),
      ).rejects.toThrow('six-digit');
      expect(mocks.verify).not.toHaveBeenCalled();
    },
  );
  it('hides provider existence details on request and verification errors', async () => {
    mocks.request.mockResolvedValue({
      error: { message: 'user does not exist', status: 400 },
    });
    await expect(provider.requestCode('person@example.test')).rejects.toThrow(
      'Could not request',
    );
    mocks.verify.mockResolvedValue({
      error: { message: 'private account details', status: 400 },
    });
    await expect(
      provider.verifyCode('person@example.test', '123456'),
    ).rejects.toThrow('invalid or expired');
  });
  it('requires configured CAPTCHA and forwards its token', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_AUTH_CAPTCHA_SITE_KEY', 'public-site-key');
    provider = await import('./authProvider');
    await expect(provider.requestCode('person@example.test')).rejects.toThrow(
      'security check',
    );
    expect(mocks.request).not.toHaveBeenCalled();
    mocks.request.mockResolvedValue({ error: null });
    await provider.requestCode('person@example.test', 'captcha-proof');
    expect(mocks.request).toHaveBeenCalledWith(
      expect.objectContaining({
        options: { shouldCreateUser: true, captchaToken: 'captcha-proof' },
      }),
    );
  });
  it('hides new requests behind kill switch without invalidating verification', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_EMAIL_OTP_ENABLED', 'false');
    provider = await import('./authProvider');
    await expect(provider.requestCode('person@example.test')).rejects.toThrow(
      'unavailable',
    );
    expect(mocks.request).not.toHaveBeenCalled();
  });
});
