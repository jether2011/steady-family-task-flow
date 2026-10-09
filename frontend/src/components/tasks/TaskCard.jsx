import React from 'react';
import { Check, RotateCcw, Pencil, Clock, ArrowRightLeft } from 'lucide-react';
import PointsBadge from '@/components/common/PointsBadge';
import MemberBadge from '@/components/family/MemberBadge';
import {
  PRIORITY_LABELS,
  PRIORITY_STYLES,
  formatDate,
  isToday,
  isPast
} from '@/lib/familyUtils';
import { cn } from '@/lib/utils';

export default function TaskCard({ task, member, onComplete, onReopen, onEdit, carriedFromDate }) {
  const done = task.status === 'DONE';
  const overdue = !done && task.due_date && isPast(task.due_date) && !isToday(task.due_date);

  return (
    <div
      className={cn(
        'group rounded-2xl border border-border bg-card p-3.5 shadow-sm hover:shadow-md hover:border-primary/30 transition-all',
        done && 'opacity-60'
      )}
    >
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap mb-1.5">
            <span
              className={cn(
                'text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded',
                PRIORITY_STYLES[task.priority]
              )}
            >
              {PRIORITY_LABELS[task.priority]}
            </span>
            {task.due_time && (
              <span className="text-[11px] text-muted-foreground inline-flex items-center gap-1">
                <Clock className="w-3 h-3" />
                {task.due_time}
              </span>
            )}
            {overdue && (
              <span className="text-[10px] font-bold text-destructive uppercase tracking-wide">
                Overdue
              </span>
            )}
          </div>

          <h4
            className={cn(
              'font-semibold text-sm leading-snug',
              done && 'line-through text-muted-foreground'
            )}
          >
            {task.title}
          </h4>
          {task.description && (
            <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{task.description}</p>
          )}

          {task.carried_from_task_id && (
            <div
              className="mt-2 inline-flex items-center gap-1 text-[11px] text-muted-foreground bg-muted px-2 py-0.5 rounded-full"
              title="This task was carried over from an earlier, unfinished task"
            >
              <ArrowRightLeft className="w-3 h-3" aria-hidden="true" />
              {carriedFromDate ? `Carried from ${formatDate(carriedFromDate)}` : 'Carried over'}
            </div>
          )}

          <div className="flex items-center justify-between mt-2.5">
            <MemberBadge member={member} />
            <PointsBadge points={task.points} size="xs" />
          </div>
        </div>

        <div className="flex flex-col gap-1.5 shrink-0">
          {done ? (
            onReopen && (
              <button
                onClick={() => onReopen(task)}
                title="Reopen task"
                className="w-8 h-8 rounded-full bg-muted text-muted-foreground hover:bg-warning/20 hover:text-warning flex items-center justify-center transition-colors"
              >
                <RotateCcw className="w-4 h-4" />
              </button>
            )
          ) : (
            <button
              onClick={() => onComplete(task)}
              title="Mark done"
              className="w-8 h-8 rounded-full border-2 border-border text-muted-foreground hover:bg-success hover:border-success hover:text-success-foreground flex items-center justify-center transition-colors"
            >
              <Check className="w-4 h-4" />
            </button>
          )}
          {onEdit && (
            <button
              onClick={() => onEdit(task)}
              title="Edit task"
              className="w-8 h-8 rounded-full text-muted-foreground hover:bg-accent hover:text-accent-foreground flex items-center justify-center transition-colors opacity-0 group-hover:opacity-100"
            >
              <Pencil className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}