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
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useSaveMember } from '@/hooks/useFamily';
import { useAuth } from '@/lib/AuthContext';
import { useToast } from '@/components/ui/use-toast';
import { MEMBER_COLORS, MEMBER_TYPE_LABELS } from '@/lib/familyUtils';
import { Loader2, Check } from 'lucide-react';
import { cn } from '@/lib/utils';

const MEMBER_TYPES = ['PARENT', 'CHILD', 'DEPENDENT'];

export default function MemberModal({ open, onOpenChange, member, family }) {
  const { user } = useAuth();
  const { toast } = useToast();
  const saveMember = useSaveMember();

  const [form, setForm] = useState({
    name: '',
    member_type: 'CHILD',
    color: MEMBER_COLORS[0],
    birth_year: '',
    active: true
  });

  useEffect(() => {
    if (open) {
      if (member) {
        setForm({
          name: member.name || '',
          member_type: member.member_type || 'CHILD',
          color: member.color || MEMBER_COLORS[0],
          birth_year: member.birth_year || '',
          active: member.active !== false
        });
      } else {
        setForm({
          name: '',
          member_type: 'CHILD',
          color: MEMBER_COLORS[Object.keys(member ? member : {}).length % MEMBER_COLORS.length] || MEMBER_COLORS[0],
          birth_year: '',
          active: true
        });
      }
    }
  }, [open, member]);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.name.trim()) {
      toast({ title: 'Name is required', variant: 'destructive' });
      return;
    }
    const payload = {
      name: form.name.trim(),
      member_type: form.member_type,
      color: form.color,
      birth_year: form.birth_year ? Number(form.birth_year) : null,
      active: form.active
    };
    try {
      if (member) {
        await saveMember.mutateAsync({ id: member.id, data: payload });
      } else {
        await saveMember.mutateAsync({
          data: {
            ...payload,
            family_id: family.id,
            owner_id: user.id
          }
        });
      }
      onOpenChange(false);
      toast({ title: member ? 'Member updated' : 'Member added' });
    } catch (err) {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>{member ? 'Edit member' : 'Add family member'}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="mname">Name</Label>
            <Input
              id="mname"
              value={form.name}
              onChange={(e) => set('name', e.target.value)}
              placeholder="e.g. Lucas"
              autoFocus
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label>Member type</Label>
            <Select value={form.member_type} onValueChange={(v) => set('member_type', v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {MEMBER_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>{MEMBER_TYPE_LABELS[t]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
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
                    'w-8 h-8 rounded-full flex items-center justify-center transition-transform',
                    form.color === c ? 'ring-2 ring-offset-2 ring-foreground scale-110' : ''
                  )}
                  style={{ backgroundColor: c }}
                >
                  {form.color === c && <Check className="w-4 h-4 text-white" />}
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="byear">Birth year (optional)</Label>
            <Input
              id="byear"
              type="number"
              value={form.birth_year}
              onChange={(e) => set('birth_year', e.target.value)}
              placeholder="e.g. 2014"
            />
          </div>
          {member && (
            <div className="flex items-center justify-between rounded-xl bg-muted/50 px-3 py-2.5">
              <div>
                <p className="text-sm font-medium">Active</p>
                <p className="text-xs text-muted-foreground">Inactive members keep their history</p>
              </div>
              <Switch checked={form.active} onCheckedChange={(v) => set('active', v)} />
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={saveMember.isPending}>
              {saveMember.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              {member ? 'Save changes' : 'Add member'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}