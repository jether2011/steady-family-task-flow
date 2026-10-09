import React from 'react';
import { Trophy, Crown } from 'lucide-react';
import MemberAvatar from '@/components/family/MemberAvatar';
import { cn } from '@/lib/utils';

const RANK_STYLES = [
  { ring: 'ring-warning', badge: 'bg-warning text-warning-foreground', icon: Crown },
  { ring: 'ring-muted-foreground/40', badge: 'bg-muted-foreground/80 text-white' },
  { ring: 'ring-warning/50', badge: 'bg-warning/60 text-warning-foreground' }
];

export default function LeaderboardList({ entries, size = 'md' }) {
  if (!entries || entries.length === 0) {
    return (
      <div className="text-center py-10 text-sm text-muted-foreground">
        No points yet. Complete some tasks to see the leaderboard.
      </div>
    );
  }
  const large = size === 'lg';
  return (
    <div className="space-y-2.5">
      {entries.map((entry, index) => {
        const rank = RANK_STYLES[index] || null;
        const RankIcon = rank?.icon;
        return (
          <div
            key={entry.memberId}
            className={cn(
              'flex items-center gap-3 rounded-2xl border border-border bg-card px-3 py-2.5',
              large && 'px-4 py-3.5',
              index === 0 && 'shadow-md'
            )}
          >
            <div className="flex items-center justify-center w-7 shrink-0">
              {RankIcon ? (
                <span
                  className={cn(
                    'inline-flex items-center justify-center w-7 h-7 rounded-full font-bold text-xs',
                    rank.badge
                  )}
                >
                  <RankIcon className="w-4 h-4" />
                </span>
              ) : (
                <span className="font-bold text-sm text-muted-foreground">{index + 1}</span>
              )}
            </div>
            <MemberAvatar member={entry} size={large ? 'md' : 'sm'} />
            <div className="flex-1 min-w-0">
              <p className={cn('font-semibold truncate', large ? 'text-base' : 'text-sm')}>{entry.name}</p>
              <p className="text-xs text-muted-foreground">
                {entry.completedTasks} task{entry.completedTasks === 1 ? '' : 's'} done
              </p>
            </div>
            <div className="text-right shrink-0">
              <p className={cn('font-bold text-warning', large ? 'text-xl' : 'text-base')}>
                {entry.points}
              </p>
              <p className="text-[10px] text-muted-foreground uppercase tracking-wide">pts</p>
            </div>
          </div>
        );
      })}
    </div>
  );
}