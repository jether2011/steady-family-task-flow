import React, { useState, useMemo } from 'react';
import { useFamily, useMembers, useAwards, usePoints, useDeleteAward } from '@/hooks/useFamily';
import AwardModal from '@/components/awards/AwardModal';
import EmptyState from '@/components/common/EmptyState';
import MemberAvatar from '@/components/family/MemberAvatar';
import { Button } from '@/components/ui/button';
import { Plus, Pencil, Trash2, Gift, Loader2 } from 'lucide-react';
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

export default function FamilyAwards() {
  const { data: family } = useFamily();
  const { data: members } = useMembers();
  const { data: awards, isLoading } = useAwards();
  const { data: transactions } = usePoints();
  const deleteAward = useDeleteAward();
  const { toast } = useToast();
  const [modalOpen, setModalOpen] = useState(false);
  const [editAward, setEditAward] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);

  const pointsByMember = useMemo(() => {
    const totals = {};
    (transactions || []).forEach((t) => {
      totals[t.member_id] = (totals[t.member_id] || 0) + (t.points || 0);
    });
    return totals;
  }, [transactions]);

  const activeMembers = useMemo(
    () => (members || []).filter((m) => m.active),
    [members]
  );

  const handleDelete = async () => {
    if (!confirmDelete) return;
    try {
      await deleteAward.mutateAsync(confirmDelete.id);
      toast({ title: 'Award deleted' });
    } catch (e) {
      toast({ title: e.message, variant: 'destructive' });
    } finally {
      setConfirmDelete(null);
    }
  };

  return (
    <div className="p-4 lg:p-8 max-w-5xl mx-auto space-y-6 animate-fade-in">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="font-heading font-bold text-2xl lg:text-3xl">Family awards</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Define milestones and rewards your family can aim for with the points they earn.
          </p>
        </div>
        <Button onClick={() => { setEditAward(null); setModalOpen(true); }}>
          <Plus className="w-4 h-4 mr-1" />
          New award
        </Button>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-6 h-6 animate-spin text-primary" />
        </div>
      ) : (awards || []).length === 0 ? (
        <EmptyState
          icon={Gift}
          title="No awards yet"
          description="Create a reward like 'Movie night' or 'Extra screen time' and set how many points it costs."
          action={
            <Button onClick={() => { setEditAward(null); setModalOpen(true); }}>
              <Plus className="w-4 h-4 mr-1" />
              New award
            </Button>
          }
        />
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {(awards || []).map((a) => {
            const canRedeem = activeMembers.filter((m) => (pointsByMember[m.id] || 0) >= a.points_cost);
            return (
              <div
                key={a.id}
                className={cn(
                  'rounded-3xl border border-border bg-card p-5 flex flex-col',
                  !a.active && 'opacity-50'
                )}
              >
                <div className="flex items-start justify-between">
                  <div
                    className="w-12 h-12 rounded-2xl flex items-center justify-center text-2xl"
                    style={{ backgroundColor: (a.color || '#94A3B8') + '22' }}
                  >
                    {a.icon || '🎁'}
                  </div>
                  <div className="flex gap-1">
                    <button
                      onClick={() => { setEditAward(a); setModalOpen(true); }}
                      className="w-8 h-8 rounded-full hover:bg-accent flex items-center justify-center text-muted-foreground hover:text-accent-foreground"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => setConfirmDelete(a)}
                      className="w-8 h-8 rounded-full hover:bg-destructive/10 flex items-center justify-center text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                <h3 className="font-heading font-semibold text-lg mt-3">{a.title}</h3>
                {a.description && (
                  <p className="text-sm text-muted-foreground mt-1 line-clamp-2">{a.description}</p>
                )}

                <div className="flex items-center justify-between mt-3 pt-3 border-t border-border">
                  <span className="text-xs text-muted-foreground">Cost</span>
                  <span className="text-xl font-bold text-warning">{a.points_cost} pts</span>
                </div>

                <div className="mt-3">
                  <p className="text-xs text-muted-foreground mb-1.5">
                    {canRedeem.length === 0 ? 'No one can redeem yet' : 'Can redeem now'}
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {canRedeem.length === 0 ? (
                      <span className="text-xs text-muted-foreground italic">Keep earning points!</span>
                    ) : (
                      canRedeem.map((m) => (
                        <MemberAvatar key={m.id} member={m} size="xs" />
                      ))
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <AwardModal
        open={modalOpen}
        onOpenChange={setModalOpen}
        award={editAward}
        family={family}
      />

      <AlertDialog open={!!confirmDelete} onOpenChange={(o) => !o && setConfirmDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this award?</AlertDialogTitle>
            <AlertDialogDescription>
              The award will be removed. Member points are not affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}