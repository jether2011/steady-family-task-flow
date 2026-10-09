import React, { useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  useFamily,
  useMembers,
  useTasks,
  usePoints,
  useCompleteTask,
  useReopenTask
} from '@/hooks/useFamily';
import { useRealtime } from '@/hooks/useRealtime';
import {
  todayKey,
  computeProgress,
  computeLeaderboard,
  PRIORITY_LABELS,
  PRIORITY_STYLES
} from '@/lib/familyUtils';
import MemberAvatar from '@/components/family/MemberAvatar';
import ProgressBar from '@/components/common/ProgressBar';
import { Check, RotateCcw, X, Clock, Trophy, Star } from 'lucide-react';
import { useToast } from '@/components/ui/use-toast';
import { cn } from '@/lib/utils';

function errMsg(e) {
  return e?.response?.data?.error?.message || e?.message || 'Something went wrong';
}

export default function Wall() {
  const today = todayKey();
  const { data: family } = useFamily();
  const { data: members } = useMembers(true);
  const { data: tasks } = useTasks({ dueDate: today });
  const { data: transactions } = usePoints();
  const completeTask = useCompleteTask();
  const reopenTask = useReopenTask();
  const { toast } = useToast();

  // Realtime: Wall Mode reflects task/completion/points changes live, with a
  // low-frequency fallback refresh when the channel is unhealthy (R19.5 / R21).
  useRealtime(family?.id);

  const memberMap = useMemo(
    () => Object.fromEntries((members || []).map((m) => [m.id, m])),
    [members]
  );
  const progress = computeProgress(tasks || []);
  const leaderboard = computeLeaderboard(transactions, members, 'week');

  const tasksByMember = useMemo(() => {
    const map = {};
    (members || []).forEach((m) => { map[m.id] = []; });
    (tasks || []).forEach((t) => {
      if (t.assigned_member_id && map[t.assigned_member_id]) {
        map[t.assigned_member_id].push(t);
      }
    });
    return map;
  }, [tasks, members]);

  const handleComplete = async (task) => {
    if (!task.assigned_member_id) return;
    try {
      await completeTask.mutateAsync({ taskId: task.id, completedByMemberId: task.assigned_member_id });
    } catch (e) {
      toast({ title: errMsg(e), variant: 'destructive' });
    }
  };

  const dateStr = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric'
  });

  return (
    // Wall Mode is landscape-first and tuned for a mounted 1024x768 display as
    // the primary target (R19.1): the shell is locked to the viewport height
    // with an internal scroll region, so the header, member columns, and
    // leaderboard stay on one screen without the page itself scrolling.
    <div className="h-screen min-h-screen bg-gradient-to-br from-background via-background to-accent/40 flex flex-col overflow-hidden">
      <header className="flex items-center justify-between px-5 py-4 border-b border-border bg-card/60 backdrop-blur-sm">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-primary flex items-center justify-center">
            <span className="text-primary-foreground font-bold text-lg">F</span>
          </div>
          <div>
            <h1 className="font-heading font-bold text-xl leading-none">{family?.name || 'FamTask'}</h1>
            <p className="text-xs text-muted-foreground mt-1">{dateStr}</p>
          </div>
        </div>

        <div className="flex items-center gap-6">
          <div className="text-center">
            <p className="font-heading font-bold text-2xl text-primary">{progress.percentage}%</p>
            <p className="text-[11px] text-muted-foreground">{progress.completed}/{progress.total} done</p>
          </div>
          <div className="hidden md:block w-40">
            <ProgressBar value={progress.completed} max={progress.total || 1} className="h-2.5" />
          </div>
          <Link
            to="/"
            className="min-h-11 min-w-11 rounded-full bg-muted hover:bg-destructive/10 hover:text-destructive flex items-center justify-center text-muted-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            title="Exit wall mode"
            aria-label="Exit wall mode"
          >
            <X className="w-5 h-5" />
          </Link>
        </div>
      </header>

      <div className="flex-1 overflow-hidden flex flex-col">
        <div className="flex-1 overflow-x-auto scrollbar-thin p-4">
          <div className="flex gap-4 h-full min-w-min">
            {(members || []).map((m) => {
              const memberTasks = tasksByMember[m.id] || [];
              const doneCount = memberTasks.filter((t) => t.status === 'DONE').length;
              return (
                <div
                  key={m.id}
                  className="w-72 shrink-0 flex flex-col rounded-3xl border border-border bg-card/70 backdrop-blur-sm overflow-hidden"
                >
                  <div className="flex items-center gap-2.5 p-4 border-b border-border">
                    <MemberAvatar member={m} size="md" />
                    <div className="flex-1 min-w-0">
                      <h2 className="font-heading font-semibold text-base truncate">{m.name}</h2>
                      <p className="text-xs text-muted-foreground">
                        {doneCount}/{memberTasks.length} done
                      </p>
                    </div>
                  </div>
                  <div className="flex-1 overflow-y-auto scrollbar-thin p-3 space-y-3">
                    {memberTasks.length === 0 ? (
                      <div className="text-center text-xs text-muted-foreground py-8">No tasks today</div>
                    ) : (
                      memberTasks.map((task) => {
                        const done = task.status === 'DONE';
                        return (
                          <div
                            key={task.id}
                            className={cn(
                              'rounded-2xl border p-3.5 transition-all',
                              done ? 'bg-success/10 border-success/30' : 'bg-card border-border'
                            )}
                          >
                            <div className="flex items-start justify-between gap-2 mb-2">
                              <span className={cn('text-[10px] font-bold uppercase px-1.5 py-0.5 rounded', PRIORITY_STYLES[task.priority])}>
                                {PRIORITY_LABELS[task.priority]}
                              </span>
                              <span className="inline-flex items-center gap-0.5 text-warning font-bold text-sm">
                                <Star className="w-3.5 h-3.5 fill-warning" />
                                {task.points}
                              </span>
                            </div>
                            <p className={cn('font-semibold text-sm leading-snug mb-3', done && 'line-through text-muted-foreground')}>
                              {task.title}
                            </p>
                            {task.due_time && (
                              <p className="text-[11px] text-muted-foreground inline-flex items-center gap-1 mb-2.5">
                                <Clock className="w-3 h-3" /> {task.due_time}
                              </p>
                            )}
                            {done ? (
                              <button
                                type="button"
                                onClick={() => reopenTask.mutate({ taskId: task.id })}
                                aria-label={`Reopen ${task.title}`}
                                className="w-full min-h-11 min-w-11 h-12 rounded-xl bg-success/15 text-success font-semibold text-sm flex items-center justify-center gap-2 hover:bg-success/25 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                              >
                                <RotateCcw className="w-5 h-5" aria-hidden="true" />
                                Done
                              </button>
                            ) : (
                              <button
                                type="button"
                                onClick={() => handleComplete(task)}
                                disabled={completeTask.isPending}
                                aria-label={`Mark ${task.title} done`}
                                className="w-full min-h-11 min-w-11 h-14 rounded-xl bg-primary text-primary-foreground font-bold text-base flex items-center justify-center gap-2 hover:bg-primary/90 active:scale-[0.98] transition-all shadow-sm disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                              >
                                <Check className="w-6 h-6" aria-hidden="true" />
                                Mark done
                              </button>
                            )}
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {leaderboard.length > 0 && (
          <div className="border-t border-border bg-card/60 backdrop-blur-sm px-5 py-3">
            <div className="flex items-center gap-2 mb-2">
              <Trophy className="w-4 h-4 text-warning" />
              <h3 className="font-heading font-semibold text-sm">This week's leaders</h3>
            </div>
            <div className="flex gap-3 overflow-x-auto no-scrollbar">
              {leaderboard.slice(0, 6).map((e, i) => (
                <div key={e.memberId} className="flex items-center gap-2 shrink-0 rounded-full bg-muted/60 px-3 py-1.5">
                  <span className={cn('font-bold text-xs', i === 0 ? 'text-warning' : 'text-muted-foreground')}>{i + 1}</span>
                  <span className="w-2 h-2 rounded-full" style={{ backgroundColor: e.color }} />
                  <span className="text-sm font-medium">{e.name}</span>
                  <span className="text-sm font-bold text-warning">{e.points}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}