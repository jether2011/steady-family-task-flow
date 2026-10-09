import React from 'react';
import { cn } from '@/lib/utils';

export default function EmptyState({ icon: Icon, title, description, action, className }) {
  return (
    <div className={cn('flex flex-col items-center justify-center text-center py-12 px-4', className)}>
      {Icon && (
        <div className="w-14 h-14 rounded-2xl bg-accent flex items-center justify-center mb-4">
          <Icon className="w-7 h-7 text-accent-foreground" />
        </div>
      )}
      <h3 className="font-heading font-semibold text-lg text-foreground">{title}</h3>
      {description && (
        <p className="text-sm text-muted-foreground mt-1 max-w-sm">{description}</p>
      )}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}