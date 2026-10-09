import React, { useState, useMemo } from 'react';
import { useMembers, usePoints } from '@/hooks/useFamily';
import { computeLeaderboard } from '@/lib/familyUtils';
import LeaderboardList from '@/components/gamification/LeaderboardList';
import { Button } from '@/components/ui/button';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { Trophy, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

const PERIODS = [
  { key: 'today', label: 'Today' },
  { key: 'week', label: 'This week' },
  { key: 'month', label: 'This month' },
  { key: 'all', label: 'All time' }
];

export default function Leaderboard() {
  const { data: members, isLoading } = useMembers(true);
  const { data: transactions } = usePoints();
  const [period, setPeriod] = useState('week');

  const entries = useMemo(
    () => computeLeaderboard(transactions, members, period),
    [transactions, members, period]
  );

  const chartData = entries.filter((e) => e.points > 0);

  return (
    <div className="p-4 lg:p-8 max-w-4xl mx-auto space-y-6 animate-fade-in">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="font-heading font-bold text-2xl lg:text-3xl">Leaderboard</h1>
          <p className="text-sm text-muted-foreground mt-1">Who's earning the most points</p>
        </div>
        <div className="inline-flex rounded-xl border border-border bg-card p-1">
          {PERIODS.map((p) => (
            <button
              key={p.key}
              onClick={() => setPeriod(p.key)}
              className={cn(
                'px-3 py-1.5 rounded-lg text-xs font-medium transition-colors',
                period === p.key ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-6 h-6 animate-spin text-primary" />
        </div>
      ) : (
        <>
          {chartData.length > 0 && (
            <div className="rounded-3xl border border-border bg-card p-5">
              <div className="flex items-center gap-2 mb-4">
                <Trophy className="w-5 h-5 text-warning" />
                <h2 className="font-heading font-semibold">Points comparison</h2>
              </div>
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chartData} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
                    <XAxis dataKey="name" tick={{ fontSize: 12 }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fontSize: 12 }} axisLine={false} tickLine={false} />
                    <Tooltip
                      cursor={{ fill: 'hsl(var(--muted))' }}
                      contentStyle={{ borderRadius: 12, border: '1px solid hsl(var(--border))', fontSize: 12 }}
                    />
                    <Bar dataKey="points" radius={[8, 8, 0, 0]}>
                      {chartData.map((entry) => (
                        <Cell key={entry.memberId} fill={entry.color} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          <div className="rounded-3xl border border-border bg-card p-5">
            <LeaderboardList entries={entries} size="lg" />
          </div>
        </>
      )}
    </div>
  );
}