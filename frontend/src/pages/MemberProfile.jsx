import { useSearchParams, Link } from 'react-router-dom';
import { useScope } from '@/hooks/useScope';
import {
  useDirectory,
  useProfile,
  useWorkHistory,
} from '@/hooks/useMemberViews';
import ReadState from '@/components/member/ReadState';
export default function MemberProfile() {
  const scope = useScope(),
    [params] = useSearchParams();
  const requested = params.get('member');
  if (scope.role === 'MEMBER' && requested && requested !== scope.memberId)
    return (
      <div role="alert" className="p-8">
        <h1>Profile unavailable</h1>
        <p>You can view your own profile only.</p>
        <Link to="/member-profile">My profile</Link>
      </div>
    );
  const id = scope.role === 'MEMBER' ? scope.memberId : requested;
  if (!id)
    return scope.role === 'MEMBER' ? (
      <div role="alert">Could not resolve your participant profile.</div>
    ) : (
      <ProfileDirectory />
    );
  return <ProfileDetails key={id} id={id} />;
}
function ProfileDirectory() {
  const query = useDirectory();
  return (
    <div className="p-8 space-y-4">
      <h1 className="text-3xl font-bold">Member profiles</h1>
      <ReadState query={query} label="profiles">
        {query.data?.length === 0 ? (
          <p>No active participants.</p>
        ) : (
          query.data?.map((member) => (
            <p key={member.id}>
              <Link to={`/member-profile?member=${member.id}`}>
                {member.name}
              </Link>
            </p>
          ))
        )}
      </ReadState>
    </div>
  );
}
function ProfileDetails({ id }) {
  const profile = useProfile(id),
    work = useWorkHistory(id);
  const pages = work.data?.pages ?? [],
    rows = pages.flatMap((page) => page.completions);
  return (
    <div className="p-4 lg:p-8 max-w-4xl mx-auto space-y-6">
      <h1 className="text-3xl font-bold">Member profile</h1>
      <ReadState query={profile} label="profile">
        {profile.data && (
          <section className="border bg-card rounded-2xl p-6 space-y-2">
            <h2 className="text-xl font-semibold">
              {profile.data.member.name}
            </h2>
            <p>{profile.data.member.member_type}</p>
            {profile.data.member.birth_year && (
              <p>Birth year: {profile.data.member.birth_year}</p>
            )}
            <p className="text-2xl font-bold">{profile.data.balance} points</p>
            <p className="text-sm text-muted-foreground">Read-only profile</p>
          </section>
        )}
      </ReadState>
      <h2 className="text-xl font-bold">Work history</h2>
      <ReadState query={work} label="work history">
        {rows.length === 0 ? (
          <p>No completed work yet.</p>
        ) : (
          pages.map((page, index) => (
            <ul className="space-y-3" key={index}>
              {page.completions.map((row) => {
                return (
                  <li key={row.id} className="border rounded-xl p-4 mb-3">
                    <p>{row.task_title ?? 'Completed task'}</p>
                    <p>
                      {row.awarded_points === undefined
                        ? 'Award details unavailable'
                        : `${row.awarded_points} points awarded`}
                    </p>
                    <time dateTime={row.completed_at}>
                      {new Date(row.completed_at).toLocaleString()}
                    </time>
                  </li>
                );
              })}
            </ul>
          ))
        )}
        <p className="text-sm text-muted-foreground">
          Showing {rows.length} work records
          {work.hasNextPage ? ' · more available' : ' · end of history'}.
        </p>
        {work.hasNextPage && (
          <button
            disabled={work.isFetchingNextPage}
            onClick={() => work.fetchNextPage()}
          >
            Load more work
          </button>
        )}
      </ReadState>
    </div>
  );
}
