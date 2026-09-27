import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getPublicEnv } from "@studyly/core/env";

let browserClient: SupabaseClient | null = null;

/**
 * Browser Supabase client.
 *
 * Reads only `NEXT_PUBLIC_*` values via the validated public env, so a missing
 * variable fails at the first call with a message naming the key rather than as
 * a confusing "undefined is not a valid URL" further down.
 */
export function getSupabaseBrowser(): SupabaseClient {
  if (!browserClient) {
    if (typeof window === "undefined") {
      throw new Error("getSupabaseBrowser must only be called in the browser (no window object).");
    }
    const env = getPublicEnv();
    browserClient = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  }
  return browserClient;
}
