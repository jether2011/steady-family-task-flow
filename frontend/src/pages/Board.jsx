import React, { useState, useMemo } from 'react';
import { DragDropContext, Droppable, Draggable } from '@hello-pangea/dnd';
import {
  useFamily,
  useMembers,
  useTasks,
  useMoveTask,
  useCompleteTask,
  useReopenTask,
  useGenerateRecurring
} from '@/hooks/useFamily';
import { STATUS_ORDER, getWeekStart } from '@/lib/familyUtils';
import TaskCard from '@/components/tasks/TaskCard';
import TaskModal from '@/components/tasks/TaskModal';
import BoardColumn from '@/components/board/BoardColumn';
import WeekSelector from '@/components/common/WeekSelector';
import EmptyState from '@/components/common/EmptyState';
import { Button } from '@/components/ui/button';
import { Plus, Repeat, Loader2, CalendarDays } from 'lucide-react';
import { useToast } from '@/components/ui/use-toast';
import { useRealtime } from '@/hooks/useRealtime';
import { cn } from '@/lib/utils';

const ACCENTS = {
  BACKLOG: 'bg-muted-foreground/40',
  TODO: 'bg-primary',
  WORKING: 'bg-info',
  DONE: 'bg-success'
};

function errMsg(e) {
  return e?.response?.data?.error?.message || e?.message || 'Something went wrong';
}

export default function Board() {
  const { data: family } = useFamily();
  const { data: members } = useMembers(true);
  const [weekStart, setWeekStart] = useState(getWeekStart());
  const { data: tasks, isLoading } = useTasks({ weekStart });
  const moveTask = useMoveTask();
  const completeTask = useCompleteTask();
  const reopenTask = useReopenTask();
  const generateRecurring = useGenerateRecurring();
  const { toast } = useToast();
  const [modalOpen, setModalOpen] = useState(false);
  const [editTask, setEditTask] = useState(null);

  // Realtime: keep tasks/points in sync for this family, with a low-frequency
  // fallback refresh when the channel is unhealthy (R21).
  useRealtime(family?.id);

  const memberMap = useMemo(
    () => Object.fromEntries((members || []).map((m) => [m.id, m])),
    [members]
  );

  const tasksByStatus = useMemo(() => {
    const map = { BACKLOG: [], TODO: [], WORKING: [], DONE: [] };
    (tasks || []).forEach((t) => {
      const key = STATUS_ORDER.includes(t.status) ? t.status : 'TODO';
      map[key].push(t);
    });
    return map;
  }, [tasks]);

  const onDragEnd = async (result) => {
    if (!result.destination) return;
    const sourceStatus = result.source.droppableId;
    const destStatus = result.destination.droppableId;
    if (sourceStatus === destStatus) return;
    const taskId = result.draggableId;
    const task = (tasks || []).find((t) => t.id === taskId);
    if (!task) return;

    try {
      if (destStatus === 'DONE' && task.status !== 'DONE') {
        if (!task.assigned_member_id) {
          toast({ title: 'Assign this task to a member first', variant: 'destructive' });
          return;
        }
        await completeTask.mutateAsync({ taskId, completedByMemberId: task.assigned_member_id });
      } else if (sourceStatus === 'DONE' && destStatus !== 'DONE') {
        await reopenTask.mutateAsync({ taskId });
      } else {
        await moveTask.mutateAsync({ id: taskId, data: { status: destStatus } });
      }
    } catch (e) {
      toast({ title: errMsg(e), variant: 'destructive' });
    }
  };

  const handleGenerate = async () => {
    try {
      const res = await generateRecurring.mutateAsync({ weekStart });
      toast({
        title: res.created > 0 ? `${res.created} recurring task${res.created === 1 ? '' : 's'} generated` : 'No new recurring tasks for this week'
      });
    } catch (e) {
      toast({ title: errMsg(e), variant: 'destructive' });
    }
  };

  return (
    <div className="p-4 lg:p-6 animate-fade-in h-full flex flex-col">
      <div className="flex items-center justify-between flex-wrap gap-3 mb-5">
        <div>
          <h1 className="font-heading font-bold text-2xl lg:text-3xl">Weekly board</h1>
          <p className="text-sm text-muted-foreground mt-1">Drag tasks between columns</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <WeekSelector weekStart={weekStart} onChange={setWeekStart} />
          <Button variant="outline" size="sm" onClick={handleGenerate} disabled={generateRecurring.isPending}>
            {generateRecurring.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Repeat className="w-4 h-4 mr-1" />}
            Generate
          </Button>
          <Button size="sm" onClick={() => { setEditTask(null); setModalOpen(true); }}>
            <Plus className="w-4 h-4 mr-1" />
            Task
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-6 h-6 animate-spin text-primary" />
        </div>
      ) : (tasks || []).length === 0 ? (
        <EmptyState
          icon={CalendarDays}
          title="No tasks this week"
          description="Add a task, or generate recurring tasks from your templates."
          action={
            <div className="flex gap-2 justify-center">
              <Button variant="outline" onClick={handleGenerate} disabled={generateRecurring.isPending}>
                <Repeat className="w-4 h-4 mr-1" />
                Generate recurring
              </Button>
              <Button onClick={() => { setEditTask(null); setModalOpen(true); }}>
                <Plus className="w-4 h-4 mr-1" />
                Add task
              </Button>
            </div>
          }
        />
      ) : (
        <DragDropContext onDragEnd={onDragEnd}>
          <div className="flex gap-4 overflow-x-auto scrollbar-thin pb-4 flex-1">
            {STATUS_ORDER.map((status) => (
              <Droppable key={status} droppableId={status}>
                {(provided) => (
                  <div ref={provided.innerRef} {...provided.droppableProps} className="h-full">
                    <BoardColumn
                      status={status}
                      tasks={tasksByStatus[status]}
                      accentClass={ACCENTS[status]}
                    >
                      {tasksByStatus[status].map((task, index) => (
                        <Draggable key={task.id} draggableId={task.id} index={index}>
                          {(p, snapshot) => (
                            <div
                              ref={p.innerRef}
                              {...p.draggableProps}
                              {...p.dragHandleProps}
                              style={p.draggableProps.style}
                              className={cn(snapshot.isDragging && 'rotate-2 shadow-lg')}
                            >
                              <TaskCard
                                task={task}
                                member={memberMap[task.assigned_member_id]}
                                onComplete={(t) => {
                                  if (!t.assigned_member_id) {
                                    toast({ title: 'Assign this task to a member first', variant: 'destructive' });
                                    return;
                                  }
                                  completeTask.mutate({ taskId: t.id, completedByMemberId: t.assigned_member_id });
                                }}
                                onReopen={(t) => reopenTask.mutate({ taskId: t.id })}
                                onEdit={(t) => { setEditTask(t); setModalOpen(true); }}
                              />
                            </div>
                          )}
                        </Draggable>
                      ))}
                      {provided.placeholder}
                      {tasksByStatus[status].length === 0 && (
                        <div className="text-center text-xs text-muted-foreground py-6">
                          Drop tasks here
                        </div>
                      )}
                    </BoardColumn>
                  </div>
                )}
              </Droppable>
            ))}
          </div>
        </DragDropContext>
      )}

      <TaskModal
        open={modalOpen}
        onOpenChange={setModalOpen}
        task={editTask}
        members={members}
        family={family}
        defaultDueDate={weekStart}
      />
    </div>
  );
}