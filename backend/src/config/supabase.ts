/**
 * Supabase client factories.
 *
 * The backend talks to Supabase through two distinct clients (see the design's
 * "RLS vs. service-role responsibility split"):
 *
 *  1. A **user-scoped client** built per request with the anon key and the
 *     caller's forwarded JWT. RLS runs under `auth.uid()`, giving a
 *     database-level isolation backstop for reads and plain CRUD (R23.1).
 *
 *  2. A **service-role singleton** built with `SUPABASE_SERVICE_ROLE_KEY`. It
 *     bypasses RLS and is used only for privileged ledger writes via
 *     `SECURITY DEFINER` RPCs. The key is server-only and never leaves the
 *     backend (R23.5).
 */
import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';

import { env } from './env.js';

/**
 * Create a Supabase client scoped to a single authenticated caller.
 *
 * The client uses the public anon key and attaches the caller's access token as
 * a `Bearer` on every request, so PostgREST/RLS evaluate policies as that user.
 * A fresh client is built per request (tokens are request-scoped), and session
 * persistence/auto-refresh are disabled because the token lifecycle is owned by
 * the frontend's Supabase session, not this server.
 *
 * @param accessToken The verified Supabase JWT forwarded from the request.
 * @returns A user-scoped {@link SupabaseClient}.
 */
export function createUserClient(accessToken: string): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
    global: {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  });
}

/**
 * Lazily-constructed service-role singleton (bypasses RLS).
 *
 * Built from `SUPABASE_SERVICE_ROLE_KEY`, which is server-only and must never be
 * returned in any client-reachable response (R23.5). Token refresh and session
 * persistence are disabled: the service role authenticates with the static key
 * and has no interactive session to maintain.
 */
let serviceRoleClient: SupabaseClient | undefined;

/**
 * Return the shared service-role client, constructing it on first use.
 *
 * Reserved for privileged, server-authored writes (ledger inserts, atomic
 * completion/reopen/redemption RPCs). Callers MUST enforce family ownership in
 * code before invoking any privileged operation through this client.
 *
 * @returns The service-role {@link SupabaseClient} singleton.
 */
export function getServiceRoleClient(): SupabaseClient {
  if (serviceRoleClient === undefined) {
    serviceRoleClient = createClient(
      env.SUPABASE_URL,
      env.SUPABASE_SERVICE_ROLE_KEY,
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
        },
      },
    );
  }
  return serviceRoleClient;
}
