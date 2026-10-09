import React, { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useSaveTemplate } from '@/hooks/useFamily';
import { useAuth } from '@/lib/AuthContext';
import { useToast } from '@/components/ui/use-toast';
import { PRIORITY_LABELS, RECURRENCE_LABELS, WEEKDAY_LABELS, MEMBER_COLORS } from '@/lib/familyUtils';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];
const RECURRENCE_TYPES = ['DAILY', 'WEEKDAYS', 'WEEKLY', 'CUSTOM'];

export default function TemplateModal({ open, onOpenChange, template, members, family }) {
  const { user } = useAuth();
  const { toast } = useToast();
  const saveTemplate = useSaveTemplate();

  const [form, setForm] = useState({
    title: '',
    description: '',
    assigned_member_id: '',
    points: 0,
    priority: 'MEDIUM',
    recurrence_type: 'DAILY',
    days: [],
    active: true
  });

  useEffect(() => {
    if (open) {
      if (template) {
        setForm({
          title: template.title || '',
          description: template.description || '',
          assigned_member_id: template.assigned_member_id || '',
          points: template.points || 0,
          priority: template.priority || 'MEDIUM',
          recurrence_type: template.recurrence_type || 'DAILY',
          days: (template.recurrence_config && template.recurrence_config.days) || [],
          active: template.active !== false
        });
      } else {
        setForm({
          title: '',
          description: '',
          assigned_member_id: '',
          points: 0,
          priority: 'MEDIUM',
          recurrence_type: 'DAILY',
          days: [],
          active: true
        });
      }
    }
  }, [open, template]);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const toggleDay = (d) =>
    setForm((f) => ({
      ...f,
      days: f.days.includes(d) ? f.days.filter((x) => x !== d) : [...f.days, d]
    }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.title.trim()) {
      toast({ title: 'Title is required', variant: 'destructive' });
      return;
    }
    if (form.recurrence_type === 'CUSTOM' && form.days.length === 0) {
      toast({ title: 'Pick at least one day for custom recurrence', variant: 'destructive' });
      return;
    }
    const payload = {
      title: form.title.trim(),
      description: form.description.trim(),
      assigned_member_id: form.assigned_member_id || '',
      points: Number(form.points) || 0,
      priority: form.priority,
      recurrence_type: form.recurrence_type,
      recurrence_config: form.recurrence_type === 'CUSTOM' ? { days: form.days } : {},
      active: form.active
    };
    try {
      if (template) {
        await saveTemplate.mutateAsync({ id: template.id, data: payload });
      } else {
        await saveTemplate.mutateAsync({
          data: { ...payload, family_id: family.id, owner_id: user.id }
        });
      }
      onOpenChange(false);
      toast({ title: template ? 'Template updated' : 'Template created' });
    } catch (err) {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>{template ? 'Edit recurring task' : 'New recurring task'}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="ttitle">Title</Label>
            <Input
              id="ttitle"
              value={form.title}
              onChange={(e) => set('title', e.target.value)}
              placeholder="e.g. Make the bed"
              autoFocus
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tdesc">Description</Label>
            <Textarea
              id="tdesc"
              value={form.description}
              onChange={(e) => set('description', e.target.value)}
              rows={2}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Assigned to</Label>
              <Select value={form.assigned_member_id} onValueChange={(v) => set('assigned_member_id', v)}>
                <SelectTrigger><SelectValue placeholder="Unassigned" /></SelectTrigger>
                <SelectContent>
                  {(members || []).filter((m) => m.active).map((m) => (
                    <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Priority</Label>
              <Select value={form.priority} onValueChange={(v) => set('priority', v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {PRIORITIES.map((p) => (
                    <SelectItem key={p} value={p}>{PRIORITY_LABELS[p]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="tpoints">Points</Label>
              <Input
                id="tpoints"
                type="number"
                min="0"
                value={form.points}
                onChange={(e) => set('points', e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Repeats</Label>
              <Select value={form.recurrence_type} onValueChange={(v) => set('recurrence_type', v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {RECURRENCE_TYPES.map((r) => (
                    <SelectItem key={r} value={r}>{RECURRENCE_LABELS[r]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {form.recurrence_type === 'CUSTOM' && (
            <div className="space-y-1.5">
              <Label>Repeat on</Label>
              <div className="flex gap-1.5">
                {WEEKDAY_LABELS.map((d, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => toggleDay(i)}
                    className={cn(
                      'flex-1 py-2 rounded-lg text-xs font-medium transition-colors',
                      form.days.includes(i)
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-muted text-muted-foreground hover:bg-accent'
                    )}
                  >
                    {d}
                  </button>
                ))}
              </div>
            </div>
          )}

          {template && (
            <div className="flex items-center justify-between rounded-xl bg-muted/50 px-3 py-2.5">
              <p className="text-sm font-medium">Active</p>
              <Switch checked={form.active} onCheckedChange={(v) => set('active', v)} />
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={saveTemplate.isPending}>
              {saveTemplate.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              {template ? 'Save' : 'Create template'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}