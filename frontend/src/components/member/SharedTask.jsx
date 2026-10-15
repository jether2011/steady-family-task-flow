import MemberAvatar from '@/components/family/MemberAvatar';
export default function SharedTask({ task, member }) {
  return (
    <article className="rounded-2xl border border-border bg-card p-4 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">
          {task.status} · {task.priority}
        </span>
        <span className="font-bold">{task.points} pts</span>
      </div>
      <details>
        <summary className="cursor-pointer font-semibold">{task.title}</summary>
        <p className="text-sm mt-2 whitespace-pre-wrap">
          {task.description || 'No description'}
        </p>
      </details>
      <p className="text-xs text-muted-foreground">
        {task.due_date ?? 'No due date'} {task.due_time ?? ''}
      </p>
      {member && (
        <div className="flex items-center gap-2">
          <MemberAvatar member={member} size="sm" />
          <span className="text-sm">{member.name}</span>
        </div>
      )}
    </article>
  );
}
