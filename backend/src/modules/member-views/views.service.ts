import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { accessRpc } from '../access/access.repository.js';
import type { RequestContext } from '../../middleware/types.js';
import { ValidationError } from '../../shared/errors/index.js';
export type ViewContext = Pick<
  RequestContext,
  | 'authUserId'
  | 'appUserId'
  | 'familyId'
  | 'role'
  | 'memberId'
  | 'accessVersion'
>;
export const readView = <T>(
  ctx: ViewContext,
  kind: string,
  input: Record<string, unknown> = {},
) =>
  accessRpc<T>('member_view_read', {
    p_auth: ctx.authUserId,
    p_kind: kind,
    p_input: input,
  });
const signature = (value: string) =>
  createHmac('sha256', env.SUPABASE_SECRET_KEY)
    .update('history-v1:' + value)
    .digest('base64url');
const Cursor = z
  .object({
    stamp: z.string().datetime({ offset: true }),
    id: z.uuid(),
    scope: z.string(),
  })
  .strict();
export function historyScope(
  ctx: ViewContext,
  kind: string,
  filter: Record<string, unknown>,
) {
  return signature(
    JSON.stringify([
      ctx.appUserId,
      ctx.familyId,
      ctx.role,
      ctx.accessVersion,
      kind,
      Object.entries(filter)
        .filter(([k, v]) => k !== 'cursor' && k !== 'limit' && v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b)),
    ]),
  );
}
export function decodeCursor(cursor: string | undefined, scope: string) {
  if (!cursor) return {};
  try {
    const [body, mac, ...extra] = cursor.split('.');
    if (!body || !mac || extra.length) throw Error();
    const expected = Buffer.from(signature(body));
    const actual = Buffer.from(mac);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      throw Error();
    const value = Cursor.parse(
      JSON.parse(Buffer.from(body, 'base64url').toString()),
    );
    if (value.scope !== scope) throw Error();
    return { pageTime: value.stamp, pageId: value.id };
  } catch {
    throw new ValidationError('Invalid history cursor or mismatched filters');
  }
}
export function encodeCursor(stamp: string, id: string, scope: string) {
  const body = Buffer.from(JSON.stringify({ stamp, id, scope })).toString(
    'base64url',
  );
  return body + '.' + signature(body);
}
export async function historyPage(
  ctx: ViewContext,
  kind: 'points' | 'completions',
  filter: Record<string, unknown> & {
    limit?: number | undefined;
    cursor?: string | undefined;
  },
) {
  const scope = historyScope(ctx, kind, filter),
    limit = filter.limit ?? 50;
  const key = kind === 'points' ? 'transactions' : 'completions';
  const result = await readView<{
    transactions: Record<string, unknown>[];
    completions?: Record<string, unknown>[];
  }>(ctx, kind, {
    ...filter,
    ...decodeCursor(filter.cursor, scope),
    cursor: undefined,
    limit: limit + 1,
  });
  const rows = result[key] ?? [],
    more = rows.length > limit,
    page = rows.slice(0, limit),
    last = page.at(-1);
  if (kind === 'completions') {
    const tasks = new Set(page.map((r) => r.task_id));
    result.transactions = result.transactions.filter((t) =>
      tasks.has(t.task_id),
    );
    result.completions = page;
  } else result.transactions = page;
  return {
    ...result,
    nextCursor:
      more && last
        ? encodeCursor(
            String(last[kind === 'points' ? 'created_at' : 'completed_at']),
            String(last.id),
            scope,
          )
        : null,
  };
}
