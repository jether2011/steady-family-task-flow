import React from 'react';
import { initials } from '@/lib/familyUtils';
import { cn } from '@/lib/utils';

export default function MemberAvatar({ member, size = 'md', className }) {
  const sizes = {
    xs: 'w-6 h-6 text-[10px]',
    sm: 'w-8 h-8 text-xs',
    md: 'w-10 h-10 text-sm',
    lg: 'w-14 h-14 text-lg',
    xl: 'w-20 h-20 text-2xl'
  };
  const color = member?.color || '#94A3B8';
  return (
    <div
      className={cn(
        'rounded-full flex items-center justify-center font-bold text-white shrink-0 shadow-sm ring-2 ring-white',
        sizes[size],
        className
      )}
      style={{ backgroundColor: color }}
      title={member?.name}
    >
      {initials(member?.name)}
    </div>
  );
}