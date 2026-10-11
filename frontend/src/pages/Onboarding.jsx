import React, { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useCreateFamily, useFamily } from '@/hooks/useFamily';
import { useAuth } from '@/lib/AuthContext';
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
import { RELATIONSHIP_LABELS, isFamilyConfigured } from '@/lib/familyUtils';
import { Loader2, ArrowRight } from 'lucide-react';

const RELATIONSHIPS = ['FATHER', 'MOTHER', 'GUARDIAN', 'OTHER'];

export default function Onboarding() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { toast } = useToast();
  const { user } = useAuth();
  const { data: family, isLoading } = useFamily();

  // The family is auto-created on first `/me` login, so onboarding only ever
  // UPDATES the existing household profile (PATCH /family) — it never creates a
  // second family. `useCreateFamily` maps to that PATCH update.
  const createFamily = useCreateFamily();

  // Prefill the responsible name from the verified Google profile so the user
  // usually only has to pick a role and confirm.
  const [form, setForm] = useState({
    name: '',
    responsible_name: '',
    relationship: 'FATHER'
  });
  const [initialized, setInitialized] = useState(false);

  // Seed the form once the family + user have loaded (family.name may already
  // be the default "My Family"; the Google full_name seeds "Your name").
  if (!initialized && family) {
    setForm({
      name: family.name && family.name !== 'My Family' ? family.name : '',
      responsible_name: user?.full_name || '',
      relationship: family.relationship || 'FATHER'
    });
    setInitialized(true);
  }

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const errorMessage = (err) =>
    (err && typeof err.message === 'string' && err.message.trim()) ||
    'Something went wrong. Please try again.';

  // Already finished setup? Don't show onboarding again — go to the dashboard.
  if (!isLoading && isFamilyConfigured(family)) {
    return <Navigate to="/" replace />;
  }

  const handleCreate = async (e) => {
    e.preventDefault();
    if (!form.name.trim()) {
      toast({ title: 'Family name is required', variant: 'destructive' });
      return;
    }
    if (!form.responsible_name.trim()) {
      toast({ title: 'Your name is required', variant: 'destructive' });
      return;
    }
    try {
      await createFamily.mutateAsync({
        name: form.name.trim(),
        responsible_name: form.responsible_name.trim(),
        relationship: form.relationship
      });
      // Make the freshly-configured family authoritative before navigating so
      // Layout sees it as configured and renders the app (not a redirect loop).
      await qc.refetchQueries({ queryKey: ['family'] });
      navigate('/', { replace: true });
    } catch (err) {
      toast({ title: 'Error', description: errorMessage(err), variant: 'destructive' });
    }
  };

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

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
                required
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
              Create family
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}
