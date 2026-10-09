import React, { useState, useEffect } from 'react';
import {
  useFamily,
  useMembers,
  useTemplates,
  useUpdateFamily,
  useDeleteTemplate
} from '@/hooks/useFamily';
import { useAuth } from '@/lib/AuthContext';
import { RELATIONSHIP_LABELS, RECURRENCE_LABELS, PRIORITY_LABELS } from '@/lib/familyUtils';
import TemplateModal from '@/components/tasks/TemplateModal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem
} from '@/components/ui/select';
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
import { Save, Plus, Pencil, Trash2, Repeat, Loader2, LogOut } from 'lucide-react';
import { cn } from '@/lib/utils';

const RELATIONSHIPS = ['FATHER', 'MOTHER', 'GUARDIAN', 'OTHER'];

export default function Settings() {
  const { data: family } = useFamily();
  const { data: members } = useMembers();
  const { data: templates, isLoading: tplLoading } = useTemplates();
  const updateFamily = useUpdateFamily();
  const deleteTemplate = useDeleteTemplate();
  const { logout } = useAuth();
  const { toast } = useToast();

  const [form, setForm] = useState({ name: '', responsible_name: '', relationship: 'FATHER' });
  const [modalOpen, setModalOpen] = useState(false);
  const [editTemplate, setEditTemplate] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);

  useEffect(() => {
    if (family) {
      setForm({
        name: family.name || '',
        responsible_name: family.responsible_name || '',
        relationship: family.relationship || 'FATHER'
      });
    }
  }, [family]);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const handleSaveFamily = async (e) => {
    e.preventDefault();
    if (!form.name.trim()) {
      toast({ title: 'Family name is required', variant: 'destructive' });
      return;
    }
    try {
      await updateFamily.mutateAsync({
        id: family.id,
        data: {
          name: form.name.trim(),
          responsible_name: form.responsible_name.trim(),
          relationship: form.relationship
        }
      });
      toast({ title: 'Family settings saved' });
    } catch (err) {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    }
  };

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

  const memberMap = members
    ? Object.fromEntries(members.map((m) => [m.id, m]))
    : {};

  return (
    <div className="p-4 lg:p-8 max-w-3xl mx-auto space-y-6 animate-fade-in">
      <div>
        <h1 className="font-heading font-bold text-2xl lg:text-3xl">Settings</h1>
        <p className="text-sm text-muted-foreground mt-1">Manage your family and recurring tasks</p>
      </div>

      <form onSubmit={handleSaveFamily} className="rounded-3xl border border-border bg-card p-5 lg:p-6 space-y-4">
        <h2 className="font-heading font-semibold text-lg">Family</h2>
        <div className="space-y-1.5">
          <Label htmlFor="fname">Family name</Label>
          <Input id="fname" value={form.name} onChange={(e) => set('name', e.target.value)} required />
        </div>
        <div className="grid sm:grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="rname">Your name</Label>
            <Input id="rname" value={form.responsible_name} onChange={(e) => set('responsible_name', e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>Your role</Label>
            <Select value={form.relationship} onValueChange={(v) => set('relationship', v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {RELATIONSHIPS.map((r) => (
                  <SelectItem key={r} value={r}>{RELATIONSHIP_LABELS[r]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <Button type="submit" disabled={updateFamily.isPending}>
          {updateFamily.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
          Save changes
        </Button>
      </form>

      <div className="rounded-3xl border border-border bg-card p-5 lg:p-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Repeat className="w-5 h-5 text-primary" />
            <h2 className="font-heading font-semibold text-lg">Recurring task templates</h2>
          </div>
          <Button size="sm" onClick={() => { setEditTemplate(null); setModalOpen(true); }}>
            <Plus className="w-4 h-4 mr-1" />
            New
          </Button>
        </div>

        {tplLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-5 h-5 animate-spin text-primary" />
          </div>
        ) : (templates || []).length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-8">
            No templates yet. Create one to auto-generate tasks each week.
          </p>
        ) : (
          <div className="space-y-2.5">
            {(templates || []).map((t) => (
              <div
                key={t.id}
                className={cn(
                  'flex items-center gap-3 rounded-2xl border border-border p-3.5',
                  !t.active && 'opacity-50'
                )}
              >
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-sm truncate">{t.title}</p>
                  <div className="flex items-center gap-2 mt-1 flex-wrap">
                    <span className="text-xs text-muted-foreground">
                      {RECURRENCE_LABELS[t.recurrence_type]}
                    </span>
                    <span className="text-xs text-muted-foreground">·</span>
                    <span className="text-xs text-muted-foreground">{PRIORITY_LABELS[t.priority]}</span>
                    {t.assigned_member_id && memberMap[t.assigned_member_id] && (
                      <>
                        <span className="text-xs text-muted-foreground">·</span>
                        <span className="inline-flex items-center gap-1 text-xs">
                          <span className="w-2 h-2 rounded-full" style={{ backgroundColor: memberMap[t.assigned_member_id].color }} />
                          {memberMap[t.assigned_member_id].name}
                        </span>
                      </>
                    )}
                    <span className="text-xs font-bold text-warning">{t.points} pts</span>
                  </div>
                </div>
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
            ))}
          </div>
        )}
      </div>

      <div className="rounded-3xl border border-border bg-card p-5 lg:p-6">
        <h2 className="font-heading font-semibold text-lg mb-1">Account</h2>
        <p className="text-sm text-muted-foreground mb-4">You're the responsible user for this family.</p>
        <Button variant="outline" onClick={() => logout()}>
          <LogOut className="w-4 h-4 mr-2" />
          Log out
        </Button>
      </div>

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