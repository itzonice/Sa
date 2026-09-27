import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getEnv } from "@studyly/core/env";

/**
 * Service-role client: bypasses RLS.
 *
 * Reserved for account deletion, the JSON export and cron jobs, where we act on
 * behalf of a user whose own policies would otherwise block the read. Every call
 * site must pass an explicit user id, because this client has no notion of who
 * is calling.
 */
export function getSupabaseAdmin(): SupabaseClient {
  const env = getEnv();
  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is required for admin operations.");
  }

  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
