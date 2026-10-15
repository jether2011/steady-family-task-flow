import { useOptionalAuth } from '@/lib/AuthContext';
export function useScope() {
  const auth = useOptionalAuth(),
    access = auth?.access;
  const prefix = [
    'scope',
    access?.user?.id ?? 'unresolved',
    access?.family?.id ?? null,
    access?.membership?.role ?? null,
    access?.membership?.accessVersion ?? null,
  ];
  return {
    prefix,
    key: (...parts) => [...prefix, ...parts],
    enabled:
      !!access &&
      auth.authChecked &&
      !auth.authError &&
      (access.state === 'READY' ||
        (access.state === 'ONBOARDING_REQUIRED' &&
          access.membership?.role === 'OWNER')),
    role: access?.membership?.role,
    memberId: access?.membership?.memberId,
    access,
    canManage: !!access?.capabilities?.includes('family:manage'),
  };
}
