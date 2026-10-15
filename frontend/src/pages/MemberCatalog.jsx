import { usePointsSummary, useCatalog } from '@/hooks/useMemberViews';
import ReadState from '@/components/member/ReadState';
export default function MemberCatalog() {
  const catalog = useCatalog(),
    summary = usePointsSummary({});
  const activeAwards = (catalog.data ?? []).filter((award) => award.active);
  return (
    <div className="p-4 lg:p-8 max-w-5xl mx-auto space-y-6">
      <h1 className="text-3xl font-bold">Family awards</h1>
      <ReadState query={summary} label="my balance">
        <p className="text-xl">My balance: {summary.data?.balance} points</p>
      </ReadState>
      <p>Your manager handles award redemption.</p>
      <ReadState query={catalog} label="awards catalog">
        {activeAwards.length === 0 ? (
          <p>No awards yet.</p>
        ) : (
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {activeAwards.map((award) => (
              <article
                key={award.id}
                className="rounded-2xl border p-5 bg-card"
              >
                <span className="text-3xl">{award.icon || '🎁'}</span>
                <h2 className="text-xl font-semibold mt-3">{award.title}</h2>
                <p>{award.description}</p>
                <p className="font-bold mt-3">{award.points_cost} points</p>
              </article>
            ))}
          </div>
        )}
      </ReadState>
    </div>
  );
}
