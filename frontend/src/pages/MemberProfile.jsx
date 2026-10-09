import React, { useMemo } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { useMembers, usePoints, useTasks, useCompletions } from '@/hooks/useFamily';
import { MEMBER_TYPE_LABELS, formatDate, periodStart } from '@/lib/familyUtils';
import MemberAvatar from '@/components/family/MemberAvatar';
import PointsBadge from '@/components/common/PointsBadge';
import EmptyState from '@/components/common/EmptyState';
import { Loader2, ArrowLeft, CheckCircle2, Users } from 'lucide-react';
import { cn } from '@/lib/utils';

export default function MemberProfile() {
  const [params] = useSearchParams();
  const memberId = params.get('member');

  const { data: members } = useMembers();
  const { data: transactions } = usePoints();
  const { data: tasks } = useTasks();
  const { data: completions, isLoading } = useCompletions(memberId);

  const member = useMemo(
    () => (members || []).find((m) => m.id === memberId),
    [members, memberId]
  );

  const taskMap = useMemo(
    () => (tasks ? Object.fromEntries(tasks.map((t) => [t.id, t])) : {}),
    [tasks]
  );

  const memberTransactions = useMemo(
    () => (transactions || []).filter((t) => t.member_id === memberId),
    [transactions, memberId]
  );

  const totalPoints = useMemo(
    () => memberTransactions.reduce((s, t) => s + (t.points || 0), 0),
    [memberTransactions]
  );

  const weekPoints = useMemo(() => {
    const start = periodStart('week');
    return memberTransactions
      .filter((t) => (t.created_date || '').slice(0, 10) >= start)
      .reduce((s, t) => s + (t.points || 0), 0);
  }, [memberTransactions]);

  const completedCount = (completions || []).length;

  if (!memberId) {
    return (
      <div className="p-4 lg:p-8 max-w-3xl mx-auto space-y-6 animate-fade-in">
        <div>
          <h1 className="font-heading font-bold text-2xl lg:text-3xl">Member profile</h1>
          <p className="text-sm text-muted-foreground mt-1">Pick a family member to view their stats.</p>
        </div>
        {(members || []).length === 0 ? (
          <EmptyState icon={Users} title="No members yet" description="Add members first to view their profiles." />
        ) : (
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {(members || []).map((m) => (
              <Link
                key={m.id}
                to={`/member-profile?member=${m.id}`}
                className={cn(
                  'rounded-3xl border border-border bg-card p-5 flex items-center gap-3 hover:shadow-sm transition-all',
                  !m.active && 'opacity-50'
                )}
              >
                <MemberAvatar member={m} size="lg" />
                <div className="min-w-0">
                  <h3 className="font-heading font-semibold truncate">{m.name}</h3>
                  <p className="text-xs text-muted-foreground">{MEMBER_TYPE_LABELS[m.member_type]}</p>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (!member) {
    return (
      <div className="p-4 lg:p-8 max-w-3xl mx-auto">
        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-6 h-6 animate-spin text-primary" />
          </div>
        ) : (
          <EmptyState icon={Users} title="Member not found" description="This member may have been removed." />
        )}
      </div>
    );
  }

  return (
    <div className="p-4 lg:p-8 max-w-3xl mx-auto space-y-6 animate-fade-in">
      <Link to="/members" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="w-4 h-4" />
        Back to members
      </Link>

      <div className="rounded-3xl border border-border bg-card p-6 flex items-center gap-4">
        <MemberAvatar member={member} size="xl" />
        <div>
          <h1 className="font-heading font-bold text-2xl">{member.name}</h1>
          <p className="text-sm text-muted-foreground">{MEMBER_TYPE_LABELS[member.member_type]}</p>
          {member.birth_year && (
            <p className="text-xs text-muted-foreground mt-0.5">Born {member.birth_year}</p>
          )}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-2xl border border-border bg-card p-4 text-center">
          <p className="text-2xl font-bold text-primary">{totalPoints}</p>
          <p className="text-xs text-muted-foreground mt-1">Total points</p>
        </div>
        <div className="rounded-2xl border border-border bg-card p-4 text-center">
          <p className="text-2xl font-bold text-warning">{weekPoints}</p>
          <p className="text-xs text-muted-foreground mt-1">This week</p>
        </div>
        <div className="rounded-2xl border border-border bg-card p-4 text-center">
          <p className="text-2xl font-bold text-success">{completedCount}</p>
          <p className="text-xs text-muted-foreground mt-1">Tasks done</p>
        </div>
      </div>

      <div>
        <h2 className="font-heading font-semibold text-lg mb-3">Completed task history</h2>
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-5 h-5 animate-spin text-primary" />
          </div>
        ) : (completions || []).length === 0 ? (
          <div className="rounded-2xl border border-border bg-card p-8 text-center">
            <CheckCircle2 className="w-8 h-8 mx-auto text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground mt-2">No completed tasks yet.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {(completions || []).map((c) => {
              const task = c.task_id ? taskMap[c.task_id] : null;
              return (
                <div
                  key={c.id}
                  className="flex items-center gap-3 rounded-2xl border border-border bg-card p-3.5"
                >
                  <div className="w-9 h-9 rounded-full bg-success/10 flex items-center justify-center shrink-0">
                    <CheckCircle2 className="w-4 h-4 text-success" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-sm truncate">{task?.title || 'Task'}</p>
                    <p className="text-xs text-muted-foreground">
                      {c.completed_at ? formatDate(c.completed_at.slice(0, 10)) : ''}
                    </p>
                  </div>
                  {task?.points > 0 && <PointsBadge points={task.points} size="sm" />}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}