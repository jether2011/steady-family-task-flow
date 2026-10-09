import React from 'react';
import MemberAvatar from './MemberAvatar';
import { cn } from '@/lib/utils';

export default function MemberBadge({ member, size = 'sm', className }) {
  if (!member) return null;
  return (
    <div className={cn('inline-flex items-center gap-1.5', className)}>
      <span
        className="w-2 h-2 rounded-full shrink-0"
        style={{ backgroundColor: member.color || '#94A3B8' }}
      />
      <span className={cn('font-medium truncate', size === 'sm' ? 'text-xs' : 'text-sm')}>
        {member.name}
      </span>
    </div>
  );
}

export function MemberAvatarBadge({ member, size = 'sm', showName = true }) {
  if (!member) return null;
  return (
    <div className="inline-flex items-center gap-1.5">
      <MemberAvatar member={member} size="xs" />
      {showName && (
        <span className={cn('font-medium truncate', size === 'sm' ? 'text-xs' : 'text-sm')}>
          {member.name}
        </span>
      )}
    </div>
  );
}