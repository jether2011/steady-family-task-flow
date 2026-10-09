export const MEMBER_COLORS = [
  '#4F46E5', '#10B981', '#F59E0B', '#EC4899',
  '#0EA5E9', '#8B5CF6', '#EF4444', '#14B8A6'
];

export const STATUS_ORDER = ['BACKLOG', 'TODO', 'WORKING', 'DONE'];
export const STATUS_LABELS = { BACKLOG: 'Backlog', TODO: 'To Do', WORKING: 'Working', DONE: 'Done' };
export const STATUS_STYLES = {
  BACKLOG: 'bg-muted text-muted-foreground',
  TODO: 'bg-accent text-accent-foreground',
  WORKING: 'bg-info/10 text-info',
  DONE: 'bg-success/10 text-success'
};

export const PRIORITY_LABELS = { LOW: 'Low', MEDIUM: 'Medium', HIGH: 'High', URGENT: 'Urgent' };
export const PRIORITY_STYLES = {
  LOW: 'bg-info/10 text-info',
  MEDIUM: 'bg-muted text-muted-foreground',
  HIGH: 'bg-warning/10 text-warning',
  URGENT: 'bg-destructive/10 text-destructive'
};

export const MEMBER_TYPE_LABELS = { PARENT: 'Parent', CHILD: 'Child', DEPENDENT: 'Dependent' };
export const RELATIONSHIP_LABELS = { FATHER: 'Father', MOTHER: 'Mother', GUARDIAN: 'Guardian', OTHER: 'Other' };
export const RECURRENCE_LABELS = { DAILY: 'Daily', WEEKDAYS: 'Weekdays', WEEKLY: 'Weekly', CUSTOM: 'Custom' };
export const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function getWeekStart(date = new Date()) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d.toISOString().slice(0, 10);
}

export function addDays(weekStart, n) {
  const d = new Date(weekStart + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

export function getWeekEnd(weekStart) {
  return addDays(weekStart, 6);
}

export function shiftWeek(weekStart, delta) {
  const d = new Date(weekStart + 'T00:00:00');
  d.setDate(d.getDate() + delta * 7);
  return d.toISOString().slice(0, 10);
}

export function formatWeekRange(weekStart) {
  const s = new Date(weekStart + 'T00:00:00');
  const e = new Date(getWeekEnd(weekStart) + 'T00:00:00');
  const opts = { month: 'short', day: 'numeric' };
  return `${s.toLocaleDateString('en-US', opts)} – ${e.toLocaleDateString('en-US', opts)}`;
}

export function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function dayName(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'short' });
}

export function todayKey() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
}

export function isToday(dateStr) {
  return dateStr === todayKey();
}

export function isPast(dateStr) {
  return dateStr < todayKey();
}

export function initials(name) {
  if (!name) return '?';
  return name.trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
}

export function periodStart(period) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = new Date(today);
  if (period === 'week') start.setDate(start.getDate() - 6);
  else if (period === 'month') start.setMonth(start.getMonth() - 1);
  else if (period === 'all') start.setFullYear(start.getFullYear() - 20);
  return start.toISOString().slice(0, 10);
}

export function computeLeaderboard(transactions, members, period) {
  const start = periodStart(period);
  const totals = {};
  for (const t of transactions || []) {
    const created = (t.created_date || '').slice(0, 10);
    if (period !== 'all' && created && created < start) continue;
    if (!totals[t.member_id]) totals[t.member_id] = { points: 0, completedTasks: 0 };
    totals[t.member_id].points += t.points || 0;
    if (t.transaction_type === 'TASK_COMPLETION' && t.points > 0) {
      totals[t.member_id].completedTasks += 1;
    }
  }
  return (members || [])
    .filter((m) => m.active)
    .map((m) => ({
      memberId: m.id,
      name: m.name,
      color: m.color,
      points: totals[m.id]?.points || 0,
      completedTasks: totals[m.id]?.completedTasks || 0
    }))
    .sort((a, b) => b.points - a.points || b.completedTasks - a.completedTasks);
}

export function computeProgress(tasks) {
  const list = tasks || [];
  const total = list.length;
  const completed = list.filter((t) => t.status === 'DONE').length;
  const percentage = total === 0 ? 0 : Math.round((completed / total) * 100);
  return { total, completed, percentage };
}