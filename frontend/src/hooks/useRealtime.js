import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
// Poll authorized APIs until provider revocation semantics have been proven.
// Raw row events can contain fields the role is no longer allowed to see.
export function useRealtime(familyId) {
  const client = useQueryClient();
  useEffect(() => {
    if (!familyId) return;
    const refresh = () => client.invalidateQueries();
    const timer = setInterval(refresh, 30000);
    window.addEventListener('focus', refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', refresh);
    };
  }, [familyId, client]);
  return { realtimeConnected: false };
}
export default useRealtime;
