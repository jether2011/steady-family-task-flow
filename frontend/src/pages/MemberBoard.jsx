import { useState } from 'react';
import { useSharedBoard, useDirectory } from '@/hooks/useMemberViews';
import { getWeekStart, STATUS_ORDER } from '@/lib/familyUtils';
import WeekSelector from '@/components/common/WeekSelector';
import ReadState from '@/components/member/ReadState';
import SharedTask from '@/components/member/SharedTask';
export default function MemberBoard() {
  const [week, setWeek] = useState(getWeekStart()),
    [memberId, setMember] = useState('');
  const board = useSharedBoard(week),
    directory = useDirectory();
  const members = directory.data ?? [],
    map = Object.fromEntries(members.map((member) => [member.id, member]));
  return (
    <div className="p-4 lg:p-8 space-y-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold">Weekly board</h1>
          <p className="text-sm text-muted-foreground">
            Shared family tasks · view only
          </p>
        </div>
        <WeekSelector weekStart={week} onChange={setWeek} />
      </header>
      <ReadState query={directory} label="member directory">
        <label className="block">
          Assigned to{' '}
          <select
            className="border rounded p-2"
            value={memberId}
            onChange={(event) => setMember(event.target.value)}
          >
            <option value="">Everyone</option>
            {members.map((member) => (
              <option key={member.id} value={member.id}>
                {member.name}
              </option>
            ))}
          </select>
        </label>
      </ReadState>
      <ReadState query={board} label="shared board">
        <div className="grid md:grid-cols-2 xl:grid-cols-4 gap-4">
          {STATUS_ORDER.map((status) => {
            const tasks = (board.data?.tasks ?? []).filter(
              (task) =>
                task.status === status &&
                (!memberId || task.assigned_member_id === memberId),
            );
            return (
              <section key={status} className="space-y-3">
                <h2 className="font-bold">
                  {status} ({tasks.length})
                </h2>
                {tasks.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No tasks.</p>
                ) : (
                  tasks.map((task) => (
                    <SharedTask
                      key={task.id}
                      task={task}
                      member={map[task.assigned_member_id]}
                    />
                  ))
                )}
              </section>
            );
          })}
        </div>
      </ReadState>
    </div>
  );
}
