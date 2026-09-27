import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getEnv } from "@studyly/core/env";

let client: SupabaseClient | null = null;
let anonClient: SupabaseClient | null = null;

/**
 * Server-side Supabase client built on the *anon* key, so every query is
 * evaluated against the signed-in user's JWT and the RLS policies in 0009 apply.
 *
 * This is the only client app code should use. The service role bypasses RLS and
 * is confined to `supabase-admin.ts`.
 */
export function getSupabaseServer(): SupabaseClient {
  if (!client) {
    const env = getEnv();
    client = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
}

/**
 * Server-side Supabase client using only the *anon* key, without any user JWT.
 * Useful for public routes where no signed-in data should be leaked.
 */
export function getSupabaseAnon(): SupabaseClient {
  if (!anonClient) {
    const env = getEnv();
    anonClient = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
  }
  return anonClient;
}
