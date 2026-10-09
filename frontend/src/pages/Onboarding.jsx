import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useCreateFamily, useSaveMember, useSaveTask } from '@/hooks/useFamily';
import { useToast } from '@/components/ui/use-toast';
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
import { MEMBER_COLORS, RELATIONSHIP_LABELS, getWeekStart, todayKey } from '@/lib/familyUtils';
import { Loader2, Sparkles, Users, ArrowRight } from 'lucide-react';

const RELATIONSHIPS = ['FATHER', 'MOTHER', 'GUARDIAN', 'OTHER'];

export default function Onboarding() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { toast } = useToast();
  // The family is auto-created on first `/me` login, so onboarding only ever
  // UPDATES the existing household profile (PATCH /family) — it never creates a
  // second family. `useCreateFamily` maps to that PATCH update.
  const createFamily = useCreateFamily();
  const saveMember = useSaveMember();
  const saveTask = useSaveTask();
  const [form, setForm] = useState({ name: '', responsible_name: '', relationship: 'FATHER' });
  const [loadingSample, setLoadingSample] = useState(false);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const handleCreate = async (e) => {
    e.preventDefault();
    if (!form.name.trim()) {
      toast({ title: 'Family name is required', variant: 'destructive' });
      return;
    }
    try {
      await createFamily.mutateAsync({
        name: form.name.trim(),
        responsible_name: form.responsible_name.trim(),
        relationship: form.relationship
      });
      await qc.refetchQueries({ queryKey: ['family'] });
      navigate('/', { replace: true });
    } catch (err) {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    }
  };

  const handleSample = async () => {
    setLoadingSample(true);
    try {
      const today = todayKey();
      const ws = getWeekStart(today);

      // 1) Update the auto-created family profile (PATCH /family). The backend
      // derives family_id/ownership from the session, so no ids are sent.
      await createFamily.mutateAsync({
        name: 'Rodrigues Family',
        responsible_name: 'Jether',
        relationship: 'FATHER'
      });

      // 2) Create the sample members (POST /family/members). The server sets
      // family_id and active defaults; we only supply the member fields.
      const sampleMembers = [
        { name: 'Ana', member_type: 'PARENT', color: MEMBER_COLORS[1] },
        { name: 'Lucas', member_type: 'CHILD', color: MEMBER_COLORS[0] },
        { name: 'Marina', member_type: 'CHILD', color: MEMBER_COLORS[2] },
        { name: 'Pedro', member_type: 'DEPENDENT', color: MEMBER_COLORS[3] }
      ];
      const [ana, lucas, marina, pedro] = await Promise.all(
        sampleMembers.map((m) => saveMember.mutateAsync({ data: m }))
      );

      // 3) Create the starter tasks (POST /family/tasks), assigning each to a
      // freshly created member. family_id/created_by_user_id are derived server
      // side from the session.
      const sampleTasks = [
        { title: 'Make bed', member: lucas, points: 5, priority: 'MEDIUM' },
        { title: 'Feed the dog', member: lucas, points: 10, priority: 'HIGH' },
        { title: 'Homework', member: marina, points: 15, priority: 'HIGH' },
        { title: 'Clean bedroom', member: marina, points: 20, priority: 'MEDIUM' },
        { title: 'Water plants', member: pedro, points: 10, priority: 'LOW' },
        { title: 'Wash dishes', member: ana, points: 15, priority: 'MEDIUM' }
      ];
      await Promise.all(
        sampleTasks.map((t) =>
          saveTask.mutateAsync({
            data: {
              title: t.title,
              assigned_member_id: t.member.id,
              status: 'TODO',
              priority: t.priority,
              points: t.points,
              due_date: today,
              week_start: ws
            }
          })
        )
      );

      await qc.refetchQueries({ queryKey: ['family'] });
      await qc.invalidateQueries({ queryKey: ['members'] });
      await qc.invalidateQueries({ queryKey: ['tasks'] });
      navigate('/', { replace: true });
    } catch (err) {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    } finally {
      setLoadingSample(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-accent via-background to-background p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="w-14 h-14 rounded-2xl bg-primary flex items-center justify-center mx-auto mb-4 shadow-lg shadow-primary/20">
            <span className="text-primary-foreground font-bold text-2xl">F</span>
          </div>
          <h1 className="font-heading font-bold text-2xl">Welcome to FamTask</h1>
          <p className="text-muted-foreground text-sm mt-2">
            Let's set up your family task board. You're the responsible — everyone else is a member you manage.
          </p>
        </div>

        <div className="rounded-3xl border border-border bg-card p-6 shadow-sm">
          <form onSubmit={handleCreate} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="fname">Family name</Label>
              <Input
                id="fname"
                value={form.name}
                onChange={(e) => set('name', e.target.value)}
                placeholder="e.g. Rodrigues Family"
                autoFocus
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rname">Your name</Label>
              <Input
                id="rname"
                value={form.responsible_name}
                onChange={(e) => set('responsible_name', e.target.value)}
                placeholder="e.g. Jether"
              />
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
            <Button type="submit" className="w-full h-11" disabled={createFamily.isPending}>
              {createFamily.isPending ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <ArrowRight className="w-4 h-4 mr-2" />
              )}
              Start fresh
            </Button>
          </form>

          <div className="relative my-5">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-border" />
            </div>
            <div className="relative flex justify-center">
              <span className="bg-card px-3 text-xs text-muted-foreground">or</span>
            </div>
          </div>

          <Button
            type="button"
            variant="outline"
            className="w-full h-11"
            onClick={handleSample}
            disabled={loadingSample}
          >
            {loadingSample ? (
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            ) : (
              <Sparkles className="w-4 h-4 mr-2" />
            )}
            Load sample family
          </Button>
          <p className="text-[11px] text-muted-foreground text-center mt-3 inline-flex items-center justify-center gap-1 w-full">
            <Users className="w-3 h-3" />
            Creates the Rodrigues family with 4 members and 6 tasks
          </p>
        </div>
      </div>
    </div>
  );
}
