import { Link, useSearchParams } from 'react-router-dom';
import { usePersonalDashboard } from '@/hooks/useMemberViews';
import ReadState from '@/components/member/ReadState';
import SharedTask from '@/components/member/SharedTask';
export default function MemberDashboard() {
  const [params] = useSearchParams();
  const query = usePersonalDashboard(),
    data = query.data;
  return (
    <div className="p-4 lg:p-8 max-w-5xl mx-auto space-y-6">
      <h1 className="text-3xl font-bold">My dashboard</h1>
      {params.get('accessMessage') === 'member' && (
        <p role="status">
          That page is not available for your role. You were returned to your
          dashboard.
        </p>
      )}
      <ReadState query={query} label="personal dashboard">
        {data && (
          <>
            <div className="rounded-3xl bg-card border p-6">
              <h2 className="text-xl font-semibold">
                Hello, {data.member.name}
              </h2>
              <p>{data.family.name}</p>
              <p className="text-3xl font-bold mt-4">{data.balance} points</p>
              <p className="text-sm text-muted-foreground">
                Current balance · snapshot{' '}
                {new Date(data.asOf).toLocaleString()}
              </p>
            </div>
            <nav className="flex flex-wrap gap-4">
              <Link to="/board">Shared board</Link>
              <Link to="/points-history">My points history</Link>
              <Link to="/member-profile">My profile</Link>
              <Link to="/leaderboard">Leaderboard</Link>
            </nav>
            <TaskSection
              title="Today's tasks (UTC)"
              tasks={data.todayTasks}
              member={data.member}
            />
            <TaskSection
              title="Upcoming tasks"
              tasks={data.upcomingTasks}
              member={data.member}
            />
            <section>
              <h2 className="text-xl font-bold mb-3">Recent points</h2>
              {data.recentTransactions.length === 0 ? (
                <p>No points activity yet.</p>
              ) : (
                data.recentTransactions.map((row) => (
                  <p key={row.id}>
                    {row.transaction_type.replaceAll('_', ' ')} · {row.points}{' '}
                    points · {new Date(row.created_at).toLocaleString()}
                  </p>
                ))
              )}
            </section>
            <section>
              <h2 className="text-xl font-bold mb-3">Recent work</h2>
              <p className="text-sm text-muted-foreground">
                Includes completions with zero points.
              </p>
              {data.recentCompletions.length === 0 ? (
                <p>No completed work yet.</p>
              ) : (
                data.recentCompletions.map((row) => (
                  <p key={row.id}>
                    {row.task_title ?? 'Completed task'} ·{' '}
                    {row.awarded_points ?? 0} points ·{' '}
                    {new Date(row.completed_at).toLocaleString()}
                  </p>
                ))
              )}
            </section>
          </>
        )}
      </ReadState>
    </div>
  );
}
function TaskSection({ title, tasks, member }) {
  return (
    <section>
      <h2 className="text-xl font-bold mb-3">{title}</h2>
      {tasks.length === 0 ? (
        <p>No tasks to show.</p>
      ) : (
        <div className="grid md:grid-cols-2 gap-3">
          {tasks.map((task) => (
            <SharedTask key={task.id} task={task} member={member} />
          ))}
        </div>
      )}
    </section>
  );
}
