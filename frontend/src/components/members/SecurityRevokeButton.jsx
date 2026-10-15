import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useScope } from '@/hooks/useScope';
import { members } from '@/api/members.api';
import { Button } from '@/components/ui/button';
export default function SecurityRevokeButton({ memberId }) {
  const scope = useScope(),
    qc = useQueryClient();
  const access = useQuery({
    queryKey: scope.key('member-access', memberId),
    queryFn: () => members.getAccess(memberId),
    enabled: scope.canRevoke,
    retry: false,
  });
  const revoke = useMutation({
    mutationFn: () => members.revokeAccess(memberId, access.data.accessVersion),
    onSettled: () => qc.invalidateQueries({ queryKey: scope.prefix }),
  });
  if (!scope.canRevoke || !access.data || access.data.status === 'REVOKED')
    return null;
  return (
    <div className="mt-3 space-y-2">
      <Button
        variant="outline"
        size="sm"
        disabled={revoke.isPending}
        onClick={() => revoke.mutate()}
      >
        Revoke login
      </Button>
      {revoke.error && (
        <p role="alert">Could not revoke access. Refresh and try again.</p>
      )}
    </div>
  );
}
