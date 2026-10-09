import React, { useState, useMemo } from 'react';
import { useFamily, useMembers, useTemplates, useDeleteTemplate } from '@/hooks/useFamily';
import { RECURRENCE_LABELS, PRIORITY_LABELS, PRIORITY_STYLES, WEEKDAY_LABELS } from '@/lib/familyUtils';
import TemplateModal from '@/components/tasks/TemplateModal';
import EmptyState from '@/components/common/EmptyState';
import { Button } from '@/components/ui/button';
import { Plus, Pencil, Trash2, Repeat, Loader2 } from 'lucide-react';
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

export default function TaskTemplates() {
  const { data: family } = useFamily();
  const { data: members } = useMembers();
  const { data: templates, isLoading } = useTemplates();
  const deleteTemplate = useDeleteTemplate();
  const { toast } = useToast();
  const [modalOpen, setModalOpen] = useState(false);
  const [editTemplate, setEditTemplate] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);

  const memberMap = useMemo(
    () => (members ? Object.fromEntries(members.map((m) => [m.id, m])) : {}),
    [members]
  );

  const handleDelete = async () => {
    if (!confirmDelete) return;
    try {
      await deleteTemplate.mutateAsync(confirmDelete.id);
      toast({ title: 'Template deleted' });
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
          <h1 className="font-heading font-bold text-2xl lg:text-3xl">Task templates</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Recurring chores and their point values. Active templates generate tasks automatically each week.
          </p>
        </div>
        <Button onClick={() => { setEditTemplate(null); setModalOpen(true); }}>
          <Plus className="w-4 h-4 mr-1" />
          New template
        </Button>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-6 h-6 animate-spin text-primary" />
        </div>
      ) : (templates || []).length === 0 ? (
        <EmptyState
          icon={Repeat}
          title="No templates yet"
          description="Create a recurring chore to auto-generate tasks each week and set how many points it's worth."
          action={
            <Button onClick={() => { setEditTemplate(null); setModalOpen(true); }}>
              <Plus className="w-4 h-4 mr-1" />
              New template
            </Button>
          }
        />
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {(templates || []).map((t) => {
            const member = t.assigned_member_id ? memberMap[t.assigned_member_id] : null;
            const days = (t.recurrence_config && t.recurrence_config.days) || [];
            return (
              <div
                key={t.id}
                className={cn(
                  'rounded-3xl border border-border bg-card p-5 flex flex-col',
                  !t.active && 'opacity-50'
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className={cn('text-[10px] font-bold px-2 py-0.5 rounded-full', PRIORITY_STYLES[t.priority])}>
                      {PRIORITY_LABELS[t.priority]}
                    </span>
                    {!t.active && (
                      <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
                        Paused
                      </span>
                    )}
                  </div>
                  <div className="flex gap-1">
                    <button
                      onClick={() => { setEditTemplate(t); setModalOpen(true); }}
                      className="w-8 h-8 rounded-full hover:bg-accent flex items-center justify-center text-muted-foreground hover:text-accent-foreground"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => setConfirmDelete(t)}
                      className="w-8 h-8 rounded-full hover:bg-destructive/10 flex items-center justify-center text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                <h3 className="font-heading font-semibold text-lg mt-3">{t.title}</h3>
                {t.description && (
                  <p className="text-sm text-muted-foreground mt-1 line-clamp-2">{t.description}</p>
                )}

                <div className="flex flex-wrap items-center gap-2 mt-3 text-xs text-muted-foreground">
                  <span className="inline-flex items-center gap-1">
                    <Repeat className="w-3.5 h-3.5" />
                    {RECURRENCE_LABELS[t.recurrence_type]}
                  </span>
                  {t.recurrence_type === 'CUSTOM' && days.length > 0 && (
                    <span className="text-muted-foreground">
                      · {days.map((d) => WEEKDAY_LABELS[d]).join(', ')}
                    </span>
                  )}
                </div>

                {member && (
                  <div className="flex items-center gap-1.5 mt-2 text-xs">
                    <span className="w-2 h-2 rounded-full" style={{ backgroundColor: member.color }} />
                    {member.name}
                  </div>
                )}

                <div className="flex items-center justify-between mt-4 pt-4 border-t border-border">
                  <span className="text-xs text-muted-foreground">Points</span>
                  <span className="text-xl font-bold text-warning">{t.points}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <TemplateModal
        open={modalOpen}
        onOpenChange={setModalOpen}
        template={editTemplate}
        members={members}
        family={family}
      />

      <AlertDialog open={!!confirmDelete} onOpenChange={(o) => !o && setConfirmDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this template?</AlertDialogTitle>
            <AlertDialogDescription>
              Existing tasks created from it stay. No new tasks will be generated.
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