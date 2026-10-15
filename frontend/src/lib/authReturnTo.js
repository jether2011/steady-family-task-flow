const routes = new Set([
  '/',
  '/board',
  '/members',
  '/leaderboard',
  '/wall',
  '/settings',
  '/task-templates',
  '/member-profile',
  '/points-history',
  '/family-awards',
  '/subscribe',
  '/billing',
  '/billing/return',
]);
const memberRoutes = new Set([
  '/',
  '/board',
  '/leaderboard',
  '/wall',
  '/member-profile',
  '/points-history',
  '/family-awards',
]);
export function safeReturnTo(value) {
  if (
    typeof value !== 'string' ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    /[\\\u0000-\u0020]/.test(value)
  )
    return '/';
  try {
    const decoded = decodeURIComponent(value);
    if (decoded.startsWith('//') || /[\\\u0000-\u0020]/.test(decoded))
      return '/';
    const url = new URL(value, 'https://app.invalid');
    if (url.origin !== 'https://app.invalid' || !routes.has(url.pathname))
      return '/';
    for (const key of [
      'access_token',
      'clear_access_token',
      'app_id',
      'app_base_url',
      'functions_version',
      'from_url',
    ])
      url.searchParams.delete(key);
    return url.pathname + url.search;
  } catch {
    return '/';
  }
}
export function loginPath(value) {
  return '/login?' + new URLSearchParams({ returnTo: safeReturnTo(value) });
}
export function accessDestination(access, returnTo = '/') {
  if (!access) return '/login';
  if (access.state === 'NO_ACCESS') return '/no-access';
  if (access.state === 'REVOKED') return '/access-revoked';
  if (access.state === 'PAYMENT_REQUIRED') return '/subscribe';
  if (access.state === 'ONBOARDING_REQUIRED')
    return access.membership?.role === 'OWNER' ? '/onboarding' : '/no-access';
  const target = safeReturnTo(returnTo);
  if (
    access.membership?.role === 'MEMBER' &&
    !memberRoutes.has(target.split('?')[0])
  )
    return '/?accessMessage=member';
  return target;
}
