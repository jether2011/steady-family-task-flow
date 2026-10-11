/**
 * Members domain API module.
 *
 * Wraps the backend "Members module" with typed functions calling `client.ts`.
 *
 * Response-envelope assumptions (design "REST API Design"):
 *   GET    /family/members      -> { members: Member[] }  (unwrapped to Member[])
 *   POST   /family/members      -> 201 { member }         (unwrapped to Member)
 *   PATCH  /family/members/:id  -> { member }             (unwrapped to Member)
 *   DELETE /family/members/:id  -> { member }             (soft delete, active=false)
 */

import { get, post, patch, request } from './client';
import type {
  Member,
  MemberCreate,
  MemberUpdate,
  AccessSummary,
} from './types';

interface MembersEnvelope {
  members: Member[];
}

interface MemberEnvelope {
  member: Member;
}

/**
 * `GET /family/members` — household members. Pass `activeOnly` to filter to the
 * active roster (serialized as `?active=true`); omit for all members.
 */
export async function list(
  activeOnly?: boolean,
  signal?: AbortSignal,
): Promise<Member[]> {
  const res = await get<MembersEnvelope>(
    '/family/members',
    activeOnly === undefined ? undefined : { active: activeOnly },
    signal,
  );
  return res.members;
}

/** `POST /family/members` — create a member. Unwraps `{ member }` → Member. */
export async function create(
  body: MemberCreate,
  signal?: AbortSignal,
): Promise<Member> {
  const res = await post<MemberEnvelope>('/family/members', body, signal);
  return res.member;
}

/** `PATCH /family/members/:id` — update a member. Unwraps `{ member }`. */
export async function update(
  id: string,
  body: MemberUpdate,
  signal?: AbortSignal,
): Promise<Member> {
  const res = await patch<MemberEnvelope>(
    `/family/members/${id}`,
    body,
    signal,
  );
  return res.member;
}

/**
 * `DELETE /family/members/:id` — soft delete (sets active=false). The backend
 * returns the updated `{ member }` rather than 204, so we unwrap it.
 */
export async function remove(
  id: string,
  signal?: AbortSignal,
): Promise<Member> {
  const res = await request<MemberEnvelope>('DELETE', `/family/members/${id}`, {
    signal,
  });
  return res.member;
}

export async function getAccess(id: string): Promise<AccessSummary | null> {
  return (
    await get<{ access: AccessSummary | null }>(`/family/members/${id}/access`)
  ).access;
}
export async function setAccess(
  id: string,
  body: {
    enabled: boolean;
    email?: string;
    role?: 'MEMBER' | 'MANAGER';
    expectedVersion: number;
  },
): Promise<AccessSummary | null> {
  return (
    await patch<{ access: AccessSummary | null }>(
      `/family/members/${id}/access`,
      body,
    )
  ).access;
}
export async function changeEmail(
  id: string,
  email: string,
  expectedVersion: number,
) {
  return post<{ status: string; expiresAt: string }>(
    `/family/members/${id}/access/email-change`,
    { email, expectedVersion },
  );
}
export const members = {
  getAccess,
  setAccess,
  changeEmail,
  list,
  create,
  update,
  remove,
};
