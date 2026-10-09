import React, { useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  useFamily,
  useMembers,
  useTasks,
  usePoints,
  useCompleteTask,
  useReopenTask
} from '@/hooks/useFamily';
import { todayKey, computeProgress, computeLeaderboard } from '@/lib/familyUtils';
import TaskCard from '@/components/tasks/TaskCard';
import TaskModal from '@/components/tasks/TaskModal';
import ProgressBar from '@/components/common/ProgressBar';
import LeaderboardList from '@/components/gamification/LeaderboardList';
import EmptyState from '@/components/common/EmptyState';
import { Button } from '@/components/ui/button';
import { Plus, CheckCircle2, Trophy, ListChecks, ArrowRight, Loader2 } from 'lucide-react';
import { useToast } from '@/components/ui/use-toast';

function errMsg(e) {
  return e?.response?.data?.error?.message || e?.message || 'Something went wrong';
}

export default function Home() {
  const today = todayKey();
  const { data: family } = useFamily();
  const { data: members } = useMembers(true);
  const { data: tasks, isLoading } = useTasks({ dueDate: today });
  const { data: transactions } = usePoints();
  const completeTask = useCompleteTask();
  const reopenTask = useReopenTask();
  const { toast } = useToast();
  const [modalOpen, setModalOpen] = useState(false);
  const [editTask, setEditTask] = useState(null);

  const memberMap = useMemo(
    () => Object.fromEntries((members || []).map((m) => [m.id, m])),
    [members]
  );
  const progress = computeProgress(tasks || []);
  const leaderboard = computeLeaderboard(transactions, members, 'week');

  const handleComplete = async (task) => {
    if (!task.assigned_member_id) {
      toast({ title: 'Assign this task to a member first', variant: 'destructive' });
      return;
    }
    try {
      await completeTask.mutateAsync({ taskId: task.id, completedByMemberId: task.assigned_member_id });
      toast({ title: 'Nice work! 🎉' });
    } catch (e) {
      toast({ title: errMsg(e), variant: 'destructive' });
    }
  };

  const handleReopen = async (task) => {
    try {
      await reopenTask.mutateAsync({ taskId: task.id });
      toast({ title: 'Task reopened' });
    } catch (e) {
      toast({ title: errMsg(e), variant: 'destructive' });
    }
  };

  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const dateStr = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric'
  });

  return (
    <div className="p-4 lg:p-8 max-w-5xl mx-auto space-y-6 animate-fade-in">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <p className="text-sm text-muted-foreground">{dateStr}</p>
          <h1 className="font-heading font-bold text-2xl lg:text-3xl">
            {greeting}{family?.responsible_name ? `, ${family.responsible_name}` : ''}
          </h1>
        </div>
        <Button onClick={() => { setEditTask(null); setModalOpen(true); }}>
          <Plus className="w-4 h-4 mr-1" />
          New task
        </Button>
      </div>

      <div className="grid lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 rounded-3xl border border-border bg-card p-5 lg:p-6">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <div className="w-9 h-9 rounded-xl bg-success/15 flex items-center justify-center">
                <CheckCircle2 className="w-5 h-5 text-success" />
              </div>
              <div>
                <h2 className="font-heading font-semibold">Today's progress</h2>
                <p className="text-xs text-muted-foreground">{dateStr}</p>
              </div>
            </div>
            <div className="text-right">
              <p className="font-heading font-bold text-3xl text-primary">{progress.percentage}%</p>
              <p className="text-xs text-muted-foreground">{progress.completed} of {progress.total} done</p>
            </div>
          </div>
          <ProgressBar value={progress.completed} max={progress.total || 1} className="h-3" />
          {(members || []).length > 0 && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 mt-5">
              {(members || []).map((m) => {
                const memberTasks = (tasks || []).filter((t) => t.assigned_member_id === m.id);
                const memberDone = memberTasks.filter((t) => t.status === 'DONE').length;
                return (
                  <div key={m.id} className="rounded-2xl bg-muted/50 p-3">
                    <div className="flex items-center gap-1.5 mb-1.5">
                      <span className="w-2 h-2 rounded-full" style={{ backgroundColor: m.color }} />
                      <span className="text-xs font-medium truncate">{m.name}</span>
                    </div>
                    <p className="text-sm font-bold">
                      {memberDone}<span className="text-muted-foreground font-normal">/{memberTasks.length}</span>
                    </p>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="rounded-3xl border border-border bg-card p-5">
          <div className="flex items-center gap-2 mb-3">
            <Trophy className="w-5 h-5 text-warning" />
            <h2 className="font-heading font-semibold">This week</h2>
          </div>
          <LeaderboardList entries={leaderboard.slice(0, 3)} />
          <Link to="/leaderboard" className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">
            Full leaderboard <ArrowRight className="w-3 h-3" />
          </Link>
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <ListChecks className="w-5 h-5 text-primary" />
            <h2 className="font-heading font-semibold text-lg">Today's tasks</h2>
          </div>
          <span className="text-xs text-muted-foreground">{(tasks || []).length} total</span>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-6 h-6 animate-spin text-primary" />
          </div>
        ) : (tasks || []).length === 0 ? (
          <EmptyState
            icon={CheckCircle2}
            title="No tasks for today"
            description="Add a task or generate recurring tasks from the board."
            action={
              <Button onClick={() => { setEditTask(null); setModalOpen(true); }}>
                <Plus className="w-4 h-4 mr-1" />
                Add a task
              </Button>
            }
          />
        ) : (
          <div className="grid sm:grid-cols-2 gap-3">
            {(tasks || []).map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                member={memberMap[task.assigned_member_id]}
                onComplete={handleComplete}
                onReopen={handleReopen}
                onEdit={(t) => { setEditTask(t); setModalOpen(true); }}
              />
            ))}
          </div>
        )}
      </div>

      <TaskModal
        open={modalOpen}
        onOpenChange={setModalOpen}
        task={editTask}
        members={members}
        family={family}
        defaultDueDate={today}
      />
    </div>
  );
}