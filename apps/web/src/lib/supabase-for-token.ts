import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getEnv } from "@studyly/core/env";

/**
 * One anon client per access token.
 *
 * Every call must be evaluated as the signed-in user, otherwise the RLS policies
 * in 0009 are never exercised and a bug in a policy would be invisible. The
 * token is part of the key, so a rotating refresh token gets a fresh client and
 * never reuses a previous user's identity.
 */
const clients = new Map<string, SupabaseClient>();

const MAX_CACHED_CLIENTS = 50;

export function getSupabaseServerForToken(token: string): SupabaseClient {
  const cached = clients.get(token);
  if (cached) return cached;

  const env = getEnv();
  const client = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

  // Bound the map. A plain FIFO eviction is enough: this is a cache of
  // credentials that are cheap to recreate, not a pool of connections.
  if (clients.size >= MAX_CACHED_CLIENTS) {
    const oldest = clients.keys().next();
    if (!oldest.done) clients.delete(oldest.value);
  }

  clients.set(token, client);
  return client;
}
