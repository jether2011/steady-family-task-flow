import React, { useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useFamily, useMembers, usePoints, useSaveMember, useDeleteMember } from '@/hooks/useFamily';
import { MEMBER_TYPE_LABELS, computeLeaderboard } from '@/lib/familyUtils';
import MemberAvatar from '@/components/family/MemberAvatar';
import MemberModal from '@/components/members/MemberModal';
import EmptyState from '@/components/common/EmptyState';
import PointsBadge from '@/components/common/PointsBadge';
import { Button } from '@/components/ui/button';
import { Plus, Pencil, Users, Loader2, PowerOff } from 'lucide-react';
import { useToast } from '@/components/ui/use-toast';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog';
import { cn } from '@/lib/utils';

export default function Members() {
  const { data: family } = useFamily();
  const { data: members, isLoading } = useMembers();
  const { data: transactions } = usePoints();
  const deleteMember = useDeleteMember();
  const { toast } = useToast();
  const [modalOpen, setModalOpen] = useState(false);
  const [editMember, setEditMember] = useState(null);
  const [confirmMember, setConfirmMember] = useState(null);

  const pointsByMember = useMemo(() => {
    const totals = {};
    (transactions || []).forEach((t) => {
      totals[t.member_id] = (totals[t.member_id] || 0) + (t.points || 0);
    });
    return totals;
  }, [transactions]);

  const handleDeactivate = async () => {
    if (!confirmMember) return;
    try {
      await deleteMember.mutateAsync(confirmMember);
      toast({ title: 'Member deactivated' });
    } catch (e) {
      toast({ title: e.message, variant: 'destructive' });
    } finally {
      setConfirmMember(null);
    }
  };

  return (
    <div className="p-4 lg:p-8 max-w-5xl mx-auto space-y-6 animate-fade-in">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="font-heading font-bold text-2xl lg:text-3xl">Family members</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Members don't log in — they're records you assign tasks to and mark done for.
          </p>
        </div>
        <Button onClick={() => { setEditMember(null); setModalOpen(true); }}>
          <Plus className="w-4 h-4 mr-1" />
          Add member
        </Button>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-6 h-6 animate-spin text-primary" />
        </div>
      ) : (members || []).length === 0 ? (
        <EmptyState
          icon={Users}
          title="No members yet"
          description="Add the people in your family to start assigning tasks."
          action={
            <Button onClick={() => { setEditMember(null); setModalOpen(true); }}>
              <Plus className="w-4 h-4 mr-1" />
              Add member
            </Button>
          }
        />
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {(members || []).map((m) => (
            <div
              key={m.id}
              className={cn(
                'rounded-3xl border border-border bg-card p-5 transition-all',
                !m.active && 'opacity-50'
              )}
            >
              <div className="flex items-start gap-3">
                <MemberAvatar member={m} size="lg" />
                <div className="flex-1 min-w-0">
                  <h3 className="font-heading font-semibold text-lg truncate">{m.name}</h3>
                  <p className="text-xs text-muted-foreground">{MEMBER_TYPE_LABELS[m.member_type]}</p>
                  {m.birth_year && (
                    <p className="text-xs text-muted-foreground mt-0.5">Born {m.birth_year}</p>
                  )}
                </div>
                <div className="flex gap-1">
                  <button
                    onClick={() => { setEditMember(m); setModalOpen(true); }}
                    className="w-8 h-8 rounded-full hover:bg-accent flex items-center justify-center text-muted-foreground hover:text-accent-foreground"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                  {m.active && (
                    <button
                      onClick={() => setConfirmMember(m)}
                      className="w-8 h-8 rounded-full hover:bg-destructive/10 flex items-center justify-center text-muted-foreground hover:text-destructive"
                    >
                      <PowerOff className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>
              <div className="flex items-center justify-between mt-4 pt-4 border-t border-border">
                <Link to={`/member-profile?member=${m.id}`} className="text-xs font-medium text-primary hover:underline">
                  View profile
                </Link>
                <PointsBadge points={pointsByMember[m.id] || 0} size="md" />
              </div>
            </div>
          ))}
        </div>
      )}

      <MemberModal
        open={modalOpen}
        onOpenChange={setModalOpen}
        member={editMember}
        family={family}
      />

      <AlertDialog open={!!confirmMember} onOpenChange={(o) => !o && setConfirmMember(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Deactivate {confirmMember?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              The member becomes inactive and won't appear for new tasks, but their history and points are kept.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeactivate}>Deactivate</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}