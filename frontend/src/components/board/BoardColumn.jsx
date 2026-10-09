import React from 'react';
import { STATUS_LABELS, STATUS_STYLES } from '@/lib/familyUtils';
import { cn } from '@/lib/utils';

export default function BoardColumn({ status, tasks, children, accentClass }) {
  const count = tasks.length;
  return (
    <div className="flex flex-col w-full min-w-[260px] max-w-[360px]">
      <div className="flex items-center justify-between px-1 mb-3">
        <div className="flex items-center gap-2">
          <span className={cn('w-2.5 h-2.5 rounded-full', accentClass)} />
          <h3 className="font-heading font-semibold text-sm">{STATUS_LABELS[status]}</h3>
        </div>
        <span className="text-xs font-bold text-muted-foreground bg-muted px-2 py-0.5 rounded-full">
          {count}
        </span>
      </div>
      <div
        className={cn(
          'flex-1 rounded-2xl bg-muted/40 border border-border/60 p-2.5 space-y-2.5 min-h-[120px] overflow-y-auto scrollbar-thin'
        )}
      >
        {children}
      </div>
    </div>
  );
}