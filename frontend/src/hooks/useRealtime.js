import { useScope } from './useScope';
import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
// Poll authorized APIs until provider revocation semantics have been proven.
// Raw row events can contain fields the role is no longer allowed to see.
export function useRealtime(familyId) {
  const client = useQueryClient();
  const { prefix, enabled } = useScope();
  const scopeId = JSON.stringify(prefix);
  useEffect(() => {
    if (!familyId || !enabled) return;
    const refresh = () =>
      client.invalidateQueries({ queryKey: JSON.parse(scopeId) });
    const timer = setInterval(refresh, 30000);
    window.addEventListener('focus', refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', refresh);
    };
  }, [familyId, client, scopeId, enabled]);
  return { realtimeConnected: false };
}
export default useRealtime;
