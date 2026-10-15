import { useState } from 'react';
import {
  useHistory,
  usePointsSummary,
  useDirectory,
} from '@/hooks/useMemberViews';
import { useScope } from '@/hooks/useScope';
import ReadState from '@/components/member/ReadState';
const labels = {
  TASK_COMPLETION: 'Earned',
  REDEMPTION: 'Spent',
  REVERSAL: 'Reversed',
  MANUAL_ADJUSTMENT: 'Adjustment',
};
export default function PointsHistory() {
  const scope = useScope(),
    [memberId, setMember] = useState(''),
    [from, setFrom] = useState(''),
    [to, setTo] = useState(''),
    [type, setType] = useState('');
  const filter = {
    ...((scope.canReadManagement ?? scope.canManage) && memberId
      ? { memberId }
      : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
  };
  const history = useHistory({ ...filter, ...(type ? { type } : {}) }),
    summary = usePointsSummary(filter),
    directory = useDirectory();
  const rows = history.data?.pages.flatMap((page) => page.transactions) ?? [],
    names = Object.fromEntries(
      (directory.data ?? []).map((member) => [member.id, member.name]),
    );
  return (
    <div className="p-4 lg:p-8 max-w-4xl mx-auto space-y-6">
      <h1 className="text-3xl font-bold">
        {(scope.canReadManagement ?? scope.canManage)
          ? 'Points history'
          : 'My points history'}
      </h1>
      <div className="flex flex-wrap gap-3">
        {(scope.canReadManagement ?? scope.canManage) && (
          <label>
            Member{' '}
            <select
              value={memberId}
              onChange={(e) => setMember(e.target.value)}
              className="border p-2 rounded"
            >
              <option value="">Whole family</option>
              {directory.data?.map((member) => (
                <option key={member.id} value={member.id}>
                  {member.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          From (UTC){' '}
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="border p-2 rounded"
          />
        </label>
        <label>
          To (UTC){' '}
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="border p-2 rounded"
          />
        </label>
        <label>
          Activity{' '}
          <select
            className="border p-2 rounded"
            value={type}
            onChange={(e) => setType(e.target.value)}
          >
            <option value="">All</option>
            {Object.entries(labels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <ReadState query={summary} label="history summary">
        <p className="text-sm text-muted-foreground">
          Full date/member range, all activity types. Balance is all-time.
        </p>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          {summary.data &&
            Object.entries(summary.data).map(([label, value]) => (
              <div className="rounded-2xl border p-4 bg-card" key={label}>
                <p className="text-2xl font-bold">{value}</p>
                <p className="capitalize">{label}</p>
              </div>
            ))}
        </div>
      </ReadState>
      <ReadState query={history} label="points history">
        {rows.length === 0 ? (
          <p>No transactions in this range.</p>
        ) : (
          <ul className="space-y-3">
            {rows.map((row) => (
              <li
                key={row.id}
                className="rounded-xl border p-4 flex justify-between gap-3"
              >
                <div>
                  <p>
                    {labels[row.transaction_type]}{' '}
                    {(scope.canReadManagement ?? scope.canManage) &&
                    names[row.member_id]
                      ? `· ${names[row.member_id]}`
                      : ''}
                  </p>
                  <time
                    dateTime={row.created_at}
                    className="text-sm text-muted-foreground"
                  >
                    {new Date(row.created_at).toLocaleString()}
                  </time>
                </div>
                <strong>
                  {row.points > 0 ? '+' : ''}
                  {row.points}
                </strong>
              </li>
            ))}
          </ul>
        )}
        <p className="text-sm text-muted-foreground">
          Showing {rows.length} records
          {history.hasNextPage ? ' · more available' : ' · end of history'}.
        </p>
        {history.hasNextPage && (
          <button
            disabled={history.isFetchingNextPage}
            onClick={() => history.fetchNextPage()}
          >
            Load more points
          </button>
        )}
      </ReadState>
    </div>
  );
}
