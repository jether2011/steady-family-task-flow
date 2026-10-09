import React from 'react';
import { Star } from 'lucide-react';
import { cn } from '@/lib/utils';

export default function PointsBadge({ points, size = 'sm', className }) {
  const sizes = {
    xs: 'text-[10px] px-1.5 py-0.5 gap-0.5',
    sm: 'text-xs px-2 py-0.5 gap-1',
    md: 'text-sm px-2.5 py-1 gap-1',
    lg: 'text-base px-3 py-1.5 gap-1.5'
  };
  return (
    <span
      className={cn(
        'inline-flex items-center font-bold rounded-full bg-warning/15 text-warning',
        sizes[size],
        className
      )}
    >
      <Star className={size === 'lg' ? 'w-4 h-4 fill-warning' : 'w-3 h-3 fill-warning'} />
      {points}
    </span>
  );
}