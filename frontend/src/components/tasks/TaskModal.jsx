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
import { useSaveTask } from '@/hooks/useFamily';
import { useAuth } from '@/lib/AuthContext';
import { useToast } from '@/components/ui/use-toast';
import { PRIORITY_LABELS, STATUS_LABELS, STATUS_ORDER, getWeekStart } from '@/lib/familyUtils';
import { Loader2 } from 'lucide-react';

const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];

export default function TaskModal({ open, onOpenChange, task, members, family, defaultDueDate, defaultStatus = 'TODO' }) {
  const { user } = useAuth();
  const { toast } = useToast();
  const saveTask = useSaveTask();

  const [form, setForm] = useState({
    title: '',
    description: '',
    assigned_member_id: '',
    status: 'TODO',
    priority: 'MEDIUM',
    points: 0,
    due_date: '',
    due_time: ''
  });

  useEffect(() => {
    if (open) {
      if (task) {
        setForm({
          title: task.title || '',
          description: task.description || '',
          assigned_member_id: task.assigned_member_id || '',
          status: task.status || 'TODO',
          priority: task.priority || 'MEDIUM',
          points: task.points || 0,
          due_date: task.due_date || '',
          due_time: task.due_time || ''
        });
      } else {
        setForm({
          title: '',
          description: '',
          assigned_member_id: '',
          status: defaultStatus,
          priority: 'MEDIUM',
          points: 0,
          due_date: defaultDueDate || '',
          due_time: ''
        });
      }
    }
  }, [open, task, defaultDueDate, defaultStatus]);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.title.trim()) {
      toast({ title: 'Title is required', variant: 'destructive' });
      return;
    }
    const week_start = form.due_date ? getWeekStart(form.due_date) : '';
    const payload = {
      title: form.title.trim(),
      description: form.description.trim(),
      assigned_member_id: form.assigned_member_id || '',
      status: form.status,
      priority: form.priority,
      points: Number(form.points) || 0,
      due_date: form.due_date || '',
      due_time: form.due_time || '',
      week_start
    };
    try {
      if (task) {
        await saveTask.mutateAsync({ id: task.id, data: payload });
      } else {
        await saveTask.mutateAsync({
          data: {
            ...payload,
            family_id: family.id,
            created_by_user_id: user.id,
            owner_id: user.id
          }
        });
      }
      onOpenChange(false);
      toast({ title: task ? 'Task updated' : 'Task created' });
    } catch (err) {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>{task ? 'Edit task' : 'New task'}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="title">Title</Label>
            <Input
              id="title"
              value={form.title}
              onChange={(e) => set('title', e.target.value)}
              placeholder="e.g. Make the bed"
              autoFocus
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="description">Description</Label>
            <Textarea
              id="description"
              value={form.description}
              onChange={(e) => set('description', e.target.value)}
              placeholder="Optional details"
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
              <Label htmlFor="points">Points</Label>
              <Input
                id="points"
                type="number"
                min="0"
                value={form.points}
                onChange={(e) => set('points', e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Status</Label>
              <Select value={form.status} onValueChange={(v) => set('status', v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {STATUS_ORDER.map((s) => (
                    <SelectItem key={s} value={s}>{STATUS_LABELS[s]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="due_date">Due date</Label>
              <Input
                id="due_date"
                type="date"
                value={form.due_date}
                onChange={(e) => set('due_date', e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="due_time">Due time</Label>
              <Input
                id="due_time"
                type="time"
                value={form.due_time}
                onChange={(e) => set('due_time', e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={saveTask.isPending}>
              {saveTask.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              {task ? 'Save changes' : 'Create task'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}