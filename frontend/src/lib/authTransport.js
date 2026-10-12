let otpBackoff = { at: 0, seconds: 60 };
export function readOtpBackoff(since) {
  return otpBackoff.at >= since ? otpBackoff.seconds : 60;
}
export async function authFetch(input, init) {
  const response = await globalThis.fetch(input, init);
  const url =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  if (
    new URL(
      url,
      globalThis.location?.origin ?? 'https://app.invalid',
    ).pathname.endsWith('/auth/v1/otp')
  ) {
    const raw = response.headers.get('Retry-After');
    const seconds =
      raw && /^\d+$/.test(raw)
        ? Number(raw)
        : raw
          ? Math.ceil((Date.parse(raw) - Date.now()) / 1000)
          : 60;
    otpBackoff = {
      at: Date.now(),
      seconds: Number.isFinite(seconds)
        ? Math.max(60, Math.min(seconds, 86400))
        : 60,
    };
  }
  return response;
}
