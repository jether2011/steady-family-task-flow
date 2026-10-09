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
import { Switch } from '@/components/ui/switch';
import { useSaveAward } from '@/hooks/useFamily';
import { useAuth } from '@/lib/AuthContext';
import { useToast } from '@/components/ui/use-toast';
import { MEMBER_COLORS } from '@/lib/familyUtils';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

const EMOJI_CHOICES = ['🎁', '🏆', '⭐', '🎮', '🍦', '🎯', '💎', '🍕', '🎬', '🎈', '📚', '🚀'];

export default function AwardModal({ open, onOpenChange, award, family }) {
  const { user } = useAuth();
  const { toast } = useToast();
  const saveAward = useSaveAward();

  const [form, setForm] = useState({
    title: '',
    description: '',
    points_cost: 0,
    icon: '🎁',
    color: MEMBER_COLORS[0],
    active: true
  });

  useEffect(() => {
    if (open) {
      if (award) {
        setForm({
          title: award.title || '',
          description: award.description || '',
          points_cost: award.points_cost || 0,
          icon: award.icon || '🎁',
          color: award.color || MEMBER_COLORS[0],
          active: award.active !== false
        });
      } else {
        setForm({
          title: '',
          description: '',
          points_cost: 0,
          icon: '🎁',
          color: MEMBER_COLORS[0],
          active: true
        });
      }
    }
  }, [open, award]);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.title.trim()) {
      toast({ title: 'Title is required', variant: 'destructive' });
      return;
    }
    if (!form.points_cost || form.points_cost <= 0) {
      toast({ title: 'Points cost must be greater than 0', variant: 'destructive' });
      return;
    }
    const payload = {
      title: form.title.trim(),
      description: form.description.trim(),
      points_cost: Number(form.points_cost) || 0,
      icon: form.icon || '🎁',
      color: form.color,
      active: form.active
    };
    try {
      if (award) {
        await saveAward.mutateAsync({ id: award.id, data: payload });
      } else {
        await saveAward.mutateAsync({
          data: { ...payload, family_id: family.id, owner_id: user.id }
        });
      }
      onOpenChange(false);
      toast({ title: award ? 'Award updated' : 'Award created' });
    } catch (err) {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>{award ? 'Edit award' : 'New award'}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="atitle">Title</Label>
            <Input
              id="atitle"
              value={form.title}
              onChange={(e) => set('title', e.target.value)}
              placeholder="e.g. Movie night"
              autoFocus
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="adesc">Description</Label>
            <Textarea
              id="adesc"
              value={form.description}
              onChange={(e) => set('description', e.target.value)}
              rows={2}
              placeholder="What does the member get?"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="acost">Points needed</Label>
            <Input
              id="acost"
              type="number"
              min="1"
              value={form.points_cost}
              onChange={(e) => set('points_cost', e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Icon</Label>
            <div className="flex flex-wrap gap-1.5">
              {EMOJI_CHOICES.map((em) => (
                <button
                  key={em}
                  type="button"
                  onClick={() => set('icon', em)}
                  className={cn(
                    'w-9 h-9 rounded-lg text-lg flex items-center justify-center transition-colors',
                    form.icon === em ? 'bg-primary/15 ring-2 ring-primary' : 'bg-muted hover:bg-accent'
                  )}
                >
                  {em}
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Color</Label>
            <div className="flex flex-wrap gap-2">
              {MEMBER_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => set('color', c)}
                  className={cn(
                    'w-7 h-7 rounded-full transition-transform',
                    form.color === c ? 'ring-2 ring-offset-2 ring-foreground scale-110' : ''
                  )}
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>
          </div>
          {award && (
            <div className="flex items-center justify-between rounded-xl bg-muted/50 px-3 py-2.5">
              <p className="text-sm font-medium">Active</p>
              <Switch checked={form.active} onCheckedChange={(v) => set('active', v)} />
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={saveAward.isPending}>
              {saveAward.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              {award ? 'Save' : 'Create award'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}