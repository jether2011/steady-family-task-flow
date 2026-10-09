import React, { useState, useMemo } from 'react';
import { usePoints, useMembers, useTasks } from '@/hooks/useFamily';
import MemberAvatar from '@/components/family/MemberAvatar';
import EmptyState from '@/components/common/EmptyState';
import { Loader2, ArrowDownCircle, ArrowUpCircle, ScrollText } from 'lucide-react';
import { cn } from '@/lib/utils';

const TYPE_LABELS = {
  TASK_COMPLETION: 'Task completed',
  REVERSAL: 'Reopened',
  MANUAL_ADJUSTMENT: 'Adjustment'
};

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'TASK_COMPLETION', label: 'Earned' },
  { key: 'REVERSAL', label: 'Reversed' }
];

export default function PointsHistory() {
  const { data: transactions } = usePoints();
  const { data: members } = useMembers();
  const { data: tasks } = useTasks();
  const [filter, setFilter] = useState('all');

  const memberMap = useMemo(
    () => (members ? Object.fromEntries(members.map((m) => [m.id, m])) : {}),
    [members]
  );
  const taskMap = useMemo(
    () => (tasks ? Object.fromEntries(tasks.map((t) => [t.id, t])) : {}),
    [tasks]
  );

  const summary = useMemo(() => {
    const list = transactions || [];
    const awarded = list.filter((t) => t.points > 0).reduce((s, t) => s + t.points, 0);
    const reversed = list.filter((t) => t.points < 0).reduce((s, t) => s + Math.abs(t.points), 0);
    const net = awarded - reversed;
    return { awarded, reversed, net };
  }, [transactions]);

  const filtered = useMemo(() => {
    const list = transactions || [];
    return filter === 'all' ? list : list.filter((t) => t.transaction_type === filter);
  }, [transactions, filter]);

  return (
    <div className="p-4 lg:p-8 max-w-3xl mx-auto space-y-6 animate-fade-in">
      <div>
        <h1 className="font-heading font-bold text-2xl lg:text-3xl">Points history</h1>
        <p className="text-sm text-muted-foreground mt-1">
          A complete audit trail of every point earned and reversed across the family.
        </p>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-2xl border border-border bg-card p-4 text-center">
          <p className="text-2xl font-bold text-success">+{summary.awarded}</p>
          <p className="text-xs text-muted-foreground mt-1">Earned</p>
        </div>
        <div className="rounded-2xl border border-border bg-card p-4 text-center">
          <p className="text-2xl font-bold text-destructive">-{summary.reversed}</p>
          <p className="text-xs text-muted-foreground mt-1">Reversed</p>
        </div>
        <div className="rounded-2xl border border-border bg-card p-4 text-center">
          <p className="text-2xl font-bold text-primary">{summary.net}</p>
          <p className="text-xs text-muted-foreground mt-1">Net total</p>
        </div>
      </div>

      <div className="flex gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={cn(
              'px-3.5 py-1.5 rounded-full text-xs font-medium transition-colors',
              filter === f.key
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted text-muted-foreground hover:bg-accent'
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      {!transactions ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-6 h-6 animate-spin text-primary" />
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={ScrollText}
          title="No transactions"
          description="Points earned and reversed will appear here."
        />
      ) : (
        <div className="space-y-2">
          {filtered.map((t) => {
            const member = t.member_id ? memberMap[t.member_id] : null;
            const task = t.task_id ? taskMap[t.task_id] : null;
            const positive = (t.points || 0) > 0;
            return (
              <div
                key={t.id}
                className="flex items-center gap-3 rounded-2xl border border-border bg-card p-3.5"
              >
                <div
                  className={cn(
                    'w-9 h-9 rounded-full flex items-center justify-center shrink-0',
                    positive ? 'bg-success/10' : 'bg-destructive/10'
                  )}
                >
                  {positive ? (
                    <ArrowDownCircle className="w-4 h-4 text-success" />
                  ) : (
                    <ArrowUpCircle className="w-4 h-4 text-destructive" />
                  )}
                </div>
                {member && <MemberAvatar member={member} size="sm" />}
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-sm truncate">
                    {member?.name || 'Unknown'} · {TYPE_LABELS[t.transaction_type] || t.transaction_type}
                  </p>
                  <p className="text-xs text-muted-foreground truncate">
                    {task?.title || (t.transaction_type === 'REVERSAL' ? 'Reopened task' : '—')}
                    {' · '}
                    {t.created_date ? new Date(t.created_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : ''}
                  </p>
                </div>
                <span
                  className={cn(
                    'text-base font-bold tabular-nums',
                    positive ? 'text-success' : 'text-destructive'
                  )}
                >
                  {positive ? '+' : ''}{t.points}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}