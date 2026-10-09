// Browser-side Supabase client for the Family Task Board frontend.
//
// This is the FRONTEND's own Supabase client, used purely for Google OAuth
// session handling (sign in / sign out / session restore) and, later, Realtime
// subscriptions. It is deliberately separate from the backend's service client.
//
// Data access does NOT go through this client — it goes through the typed REST
// client in `@/api/client` with the Bearer token minted here (DP-1 data-layer
// swap). Keep this module tiny and side-effect-light so it can be imported from
// anywhere (AuthContext, realtime hooks) without surprises.
//
// Configuration comes from Vite build-time env vars (R24.6 / R29.7):
//   VITE_SUPABASE_URL       — the project URL, e.g. https://xyz.supabase.co
//   VITE_SUPABASE_ANON_KEY  — the public anon key (safe to ship to the browser)

import { createClient } from '@supabase/supabase-js';

// Read Vite build-time env without depending on ambient `vite/client` types
// (keeps this module self-contained, matching the approach in `@/api/client`).
/** @type {{ VITE_SUPABASE_URL?: string, VITE_SUPABASE_ANON_KEY?: string }} */
const env = /** @type {any} */ (import.meta).env ?? {};
const supabaseUrl = env.VITE_SUPABASE_URL;
const supabaseAnonKey = env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  // Fail loud in dev so a missing env var doesn't turn into a confusing
  // "no session" at runtime. The message intentionally names the keys, not
  // their values, so nothing secret is logged.
  console.error(
    '[supabaseClient] Missing VITE_SUPABASE_URL and/or VITE_SUPABASE_ANON_KEY. ' +
      'Set them in the frontend environment (.env.local) before building.',
  );
}

/**
 * Shared Supabase browser client. `persistSession` + `autoRefreshToken` keep
 * the user signed in across reloads, and `detectSessionInUrl` lets supabase-js
 * complete the OAuth redirect (parsing the token out of the callback URL) so
 * `onAuthStateChange` fires once Google sends the user back.
 */
export const supabase = createClient(supabaseUrl ?? '', supabaseAnonKey ?? '', {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    flowType: 'pkce',
  },
});

export default supabase;
