/**
 * Auth / bootstrap service — the business logic behind `GET /api/v1/me`.
 *
 * This is the ONLY place a `responsible_users` row and its 1:1 `families` row
 * are created (R1.4). The context resolver (`middleware/context.ts`) only reads
 * these rows; it never creates them, so a brand-new Google sign-in arrives here
 * with `request.ctx` possibly all-`null` and this service bootstraps the
 * missing pieces, then returns the composed {@link MePayload}.
 *
 * ### Identity source (bootstrap seed)
 *
 * The `auth_user_id` is the cryptographically-verified JWT `sub` — the only
 * trusted identity (R1.7, R23.2). The optional email/display-name/avatar used
 * to seed the profile on first creation also come from the verified token
 * (`request.authClaims`, extracted in `authentication.ts`), never from the
 * request body/query/headers. Any claim the token omits is stored as `null`.
 *
 * ### One family per user (R1.6) and the race
 *
 * `families.responsible_user_id` is `UNIQUE`, so the database guarantees at
 * most one family per responsible user. Creation is therefore an
 * insert-then-fallback: we try to insert, and if a concurrent first request
 * won the race (Postgres `unique_violation`, SQLSTATE `23505`) we simply
 * re-select the family the winner created. The same pattern guards the
 * `responsible_users` insert against `UNIQUE(auth_user_id)`.
 *
 * ### Which Supabase client
 *
 * All reads/writes here use the **service-role client**, consistent with the
 * context resolver: bootstrap would otherwise be circular under RLS
 * (`current_family_id()` depends on the very rows being created). Every query
 * is still filtered strictly by the verified `auth_user_id`, so no cross-family
 * data is reachable.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import { getServiceRoleClient } from '../../config/supabase.js';
import type { AuthClaims } from '../../middleware/types.js';
import type {
  FamilyDTO,
  FamilyRow,
  MePayload,
  ResponsibleUserRow,
} from '../../shared/types/index.js';

/** Default household name applied when a family is created on first login. */
const DEFAULT_FAMILY_NAME = 'My Family';

/** Postgres `unique_violation` SQLSTATE — a lost insert race, re-select instead. */
const UNIQUE_VIOLATION = '23505';

/** Columns selected for a responsible-user row (keeps selects explicit/typed). */
const RESPONSIBLE_COLUMNS =
  'id, auth_user_id, name, email, avatar_url, relationship, created_at, updated_at';

/** Columns selected for a family row. */
const FAMILY_COLUMNS =
  'id, responsible_user_id, name, avatar_url, created_at, updated_at';

/** Narrow a Supabase error to a Postgres unique-violation. */
function isUniqueViolation(error: { code?: string } | null): boolean {
  return error?.code === UNIQUE_VIOLATION;
}

/**
 * Find the responsible-user row for a verified auth user, or `null` if none.
 */
async function findResponsibleUser(
  db: SupabaseClient,
  authUserId: string,
): Promise<ResponsibleUserRow | null> {
  const { data, error } = await db
    .from('responsible_users')
    .select(RESPONSIBLE_COLUMNS)
    .eq('auth_user_id', authUserId)
    .maybeSingle<ResponsibleUserRow>();
  if (error) {
    throw error;
  }
  return data ?? null;
}

/**
 * Resolve the responsible-user row for a verified auth user, creating it on
 * first login from the verified token claims. Handles the
 * `UNIQUE(auth_user_id)` race by re-selecting the row a concurrent request
 * created.
 */
async function ensureResponsibleUser(
  db: SupabaseClient,
  authUserId: string,
  claims: AuthClaims,
): Promise<ResponsibleUserRow> {
  const existing = await findResponsibleUser(db, authUserId);
  if (existing !== null) {
    return existing;
  }

  const insert = await db
    .from('responsible_users')
    .insert({
      auth_user_id: authUserId,
      // Seed from verified claims only; store null for anything the token omits.
      name: claims.name ?? null,
      email: claims.email ?? null,
      avatar_url: claims.avatarUrl ?? null,
    })
    .select(RESPONSIBLE_COLUMNS)
    .single<ResponsibleUserRow>();

  if (insert.error) {
    if (isUniqueViolation(insert.error)) {
      // A concurrent first request created it — re-select the winner's row.
      const raced = await findResponsibleUser(db, authUserId);
      if (raced !== null) {
        return raced;
      }
    }
    throw insert.error;
  }

  return insert.data;
}

/**
 * Find the family owned by a responsible user, or `null` if none.
 */
async function findFamily(
  db: SupabaseClient,
  responsibleUserId: string,
): Promise<FamilyRow | null> {
  const { data, error } = await db
    .from('families')
    .select(FAMILY_COLUMNS)
    .eq('responsible_user_id', responsibleUserId)
    .maybeSingle<FamilyRow>();
  if (error) {
    throw error;
  }
  return data ?? null;
}

/**
 * Resolve the family for a responsible user, creating exactly one on first
 * login (R1.4). `UNIQUE(responsible_user_id)` guarantees at most one (R1.6);
 * the `unique_violation` race is handled by re-selecting the family the
 * concurrent winner created.
 */
async function ensureFamily(
  db: SupabaseClient,
  responsibleUserId: string,
): Promise<FamilyRow> {
  const existing = await findFamily(db, responsibleUserId);
  if (existing !== null) {
    return existing;
  }

  const insert = await db
    .from('families')
    .insert({
      responsible_user_id: responsibleUserId,
      name: DEFAULT_FAMILY_NAME,
    })
    .select(FAMILY_COLUMNS)
    .single<FamilyRow>();

  if (insert.error) {
    if (isUniqueViolation(insert.error)) {
      const raced = await findFamily(db, responsibleUserId);
      if (raced !== null) {
        return raced;
      }
    }
    throw insert.error;
  }

  return insert.data;
}

/**
 * Compose the single frontend "family" object from the household row and the
 * responsible user's `relationship` + display name (R2.2 DTO split).
 */
function composeFamilyDTO(
  family: FamilyRow,
  responsible: ResponsibleUserRow,
): FamilyDTO {
  return {
    id: family.id,
    name: family.name,
    avatar_url: family.avatar_url,
    relationship: responsible.relationship,
    responsible_name: responsible.name,
  };
}

/**
 * Bootstrap (or fetch) the caller's profile + family and return the composed
 * `GET /me` payload.
 *
 * Idempotent: the first call creates the responsible-user and family rows; every
 * later call returns the same family without creating another (R1.5).
 *
 * @param authUserId The verified Supabase `sub` (never from the request body).
 * @param claims     Verified identity claims used only to seed a new profile.
 */
export async function bootstrapMe(
  authUserId: string,
  claims: AuthClaims,
): Promise<MePayload> {
  const db = getServiceRoleClient();

  const responsible = await ensureResponsibleUser(db, authUserId, claims);
  const family = await ensureFamily(db, responsible.id);

  return {
    family: composeFamilyDTO(family, responsible),
    responsibleUser: {
      id: responsible.id,
      email: responsible.email,
      avatar_url: responsible.avatar_url,
    },
  };
}
