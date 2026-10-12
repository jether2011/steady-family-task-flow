import { readOtpBackoff } from './authTransport';
import { supabase } from './supabaseClient';
export const emailOtpEnabled =
  import.meta.env.VITE_EMAIL_OTP_ENABLED === 'true';
export const captchaSiteKey = import.meta.env.VITE_AUTH_CAPTCHA_SITE_KEY ?? '';
export function normalizeLoginEmail(value) {
  return value.trim().toLowerCase();
}
export function validLoginEmail(value) {
  return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}
export class SignInError extends Error {
  constructor(message, retryAfter = 60) {
    super(message);
    this.name = 'SignInError';
    this.retryAfter = retryAfter;
  }
}
// AuthApiError does not expose response headers. Supabase client's custom fetch
// adapter attaches only Retry-After; no provider message or email enters the UI.
export function retryDelay(error) {
  return Math.max(60, Math.min(86400, Number(error?.retryAfter) || 60));
}
export async function requestCode(email, captchaToken) {
  const normalized = normalizeLoginEmail(email);
  if (!emailOtpEnabled)
    throw new SignInError(
      'Email sign-in is currently unavailable. Continue with Google.',
    );
  if (!validLoginEmail(normalized))
    throw new SignInError('Enter a valid email address.');
  if (captchaSiteKey && !captchaToken)
    throw new SignInError('Complete the security check to continue.');
  const started = Date.now();
  let result;
  try {
    result = await supabase.auth.signInWithOtp({
      email: normalized,
      options: {
        shouldCreateUser: true,
        ...(captchaToken ? { captchaToken } : {}),
      },
    });
  } catch {
    throw new SignInError('Could not request a code. Please try again later.');
  }
  if (result.error)
    throw new SignInError(
      result.error.status === 429
        ? 'Please wait before requesting another code.'
        : 'Could not request a code. Please try again later.',
      Math.max(retryDelay(result.error), readOtpBackoff(started)),
    );
  return { email: normalized, retryAfter: 60 };
}
export async function verifyCode(email, token) {
  if (!/^\d{6}$/.test(token))
    throw new SignInError('Enter the six-digit code from your email.');
  let result;
  try {
    result = await supabase.auth.verifyOtp({
      email: normalizeLoginEmail(email),
      token,
      type: 'email',
    });
  } catch {
    throw new SignInError('Could not verify the code. Please try again.');
  }
  if (result.error || !result.data?.session)
    throw new SignInError(
      'This code is invalid or expired. Request a new code.',
    );
  return result.data.session;
}
export function resolutionMessage(error) {
  if (error?.code === 'ACCESS_CONFLICT')
    return 'We could not safely connect this sign-in. Try your previous sign-in method or contact support.';
  return 'Could not resolve family access. Retry or change account. If this continues, contact support.';
}
