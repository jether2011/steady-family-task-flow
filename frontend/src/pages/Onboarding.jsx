import { useScope } from '@/hooks/useScope';
import React, { useState, useRef } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { family } from '@/api/family.api';
import { accessDestination, loginPath } from '@/lib/authReturnTo';
import { useAuth } from '@/lib/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import { RELATIONSHIP_LABELS } from '@/lib/familyUtils';
import { Loader2, ArrowRight } from 'lucide-react';

const RELATIONSHIPS = ['FATHER', 'MOTHER', 'GUARDIAN', 'OTHER'];

export default function Onboarding({ creating = false }) {
  const scope = useScope();
  const navigate = useNavigate();
  const auth = useAuth();
  const {
    data: onboarding,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: scope.key('onboarding'),
    queryFn: ({ signal }) => family.onboarding(signal),
    enabled: !creating && auth.access?.membership?.role === 'OWNER',
    retry: false,
  });
  const intent = useRef({ body: null, key: crypto.randomUUID() });
  const [form, setForm] = useState({
    name: '',
    responsible_name: auth.access?.user?.displayName ?? '',
    relationship: 'FATHER',
  });
  const [initialized, setInitialized] = useState(false);
  const [saving, setSaving] = useState(false);
  const [submitError, setSubmitError] = useState('');
  if (!initialized && onboarding) {
    setForm({
      name:
        onboarding.family.name === 'My Family' ? '' : onboarding.family.name,
      responsible_name:
        onboarding.family.responsible_name ??
        auth.access?.user?.displayName ??
        '',
      relationship: onboarding.family.relationship ?? 'FATHER',
    });
    setInitialized(true);
  }
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  if (
    auth.isLoadingAuth ||
    (!creating && isLoading && auth.access?.membership?.role === 'OWNER')
  )
    return (
      <main role="status" className="p-8">
        Loading family profile…
      </main>
    );
  if (!auth.isAuthenticated) return <Navigate replace to={loginPath('/')} />;
  if (auth.authError) return <Navigate replace to="/access-error" />;
  if (
    creating &&
    (auth.access?.state !== 'NO_ACCESS' || !auth.access?.signupAvailable)
  )
    return <Navigate replace to={accessDestination(auth.access)} />;
  if (
    !creating &&
    (auth.access?.membership?.role !== 'OWNER' ||
      auth.access?.state !== 'ONBOARDING_REQUIRED')
  )
    return <Navigate replace to={accessDestination(auth.access)} />;
  if (error)
    return (
      <main className="p-8">
        <p role="alert">Could not load family profile.</p>
        <button onClick={() => refetch()}>Retry</button>
      </main>
    );
  const handleSubmit = async (e) => {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setSubmitError('');
    try {
      const body = {
        ...form,
        name: form.name.trim(),
        responsible_name: form.responsible_name.trim(),
      };
      const encoded = JSON.stringify(body);
      if (intent.current.body !== null && intent.current.body !== encoded)
        intent.current.key = crypto.randomUUID();
      intent.current.body = encoded;
      const result = creating
        ? await family.create(body, intent.current.key)
        : await family.updateOnboarding(body);
      await auth.retryAccessResolution();
      navigate(
        result.nextAction === 'OPEN_DASHBOARD'
          ? '/'
          : result.nextAction === 'COMPLETE_PROFILE'
            ? '/onboarding'
            : '/subscribe',
        { replace: true },
      );
    } catch (err) {
      setSubmitError(err?.message || 'Could not save family. Please retry.');
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-accent via-background to-background p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="w-14 h-14 rounded-2xl bg-primary flex items-center justify-center mx-auto mb-4 shadow-lg shadow-primary/20">
            <span className="text-primary-foreground font-bold text-2xl">
              F
            </span>
          </div>
          <h1 className="font-heading font-bold text-2xl">
            Welcome to FamTask
          </h1>
          <p className="text-muted-foreground text-sm mt-2">
            {creating
              ? 'Create a family draft. A subscription will be required before using your board.'
              : 'Complete your family profile to continue.'}
          </p>
        </div>

        <div className="rounded-3xl border border-border bg-card p-6 shadow-sm">
          <form onSubmit={handleSubmit} className="space-y-4">
            {submitError && <p role="alert">{submitError}</p>}
            <div className="space-y-1.5">
              <Label htmlFor="fname">Family name</Label>
              <Input
                id="fname"
                value={form.name}
                onChange={(e) => set('name', e.target.value)}
                placeholder="e.g. Rodrigues Family"
                autoFocus
                maxLength={120}
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
                maxLength={120}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="relationship">Relationship to the family</Label>
              <Select
                value={form.relationship}
                onValueChange={(v) => set('relationship', v)}
              >
                <SelectTrigger id="relationship">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RELATIONSHIPS.map((r) => (
                    <SelectItem key={r} value={r}>
                      {RELATIONSHIP_LABELS[r]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button type="submit" className="w-full h-11" disabled={saving}>
              {saving ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <ArrowRight className="w-4 h-4 mr-2" />
              )}
              {creating ? 'Create family' : 'Save profile'}
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}
