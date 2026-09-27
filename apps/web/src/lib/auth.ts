import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError } from "./http/errors";
import { getSupabaseServer } from "./supabase-server";

export type SessionUser = {
  id: string;
  email: string | null;
};

/**
 * Resolves the caller from the bearer token, or throws 401.
 *
 * We deliberately do not use `getUser()`'s auto-refresh or a cookie session: the
 * browser already holds the access token and sends it per request, and a fresh
 * anon client per call keeps this a pure function of the request.
 */
export async function requireUser(request: Request): Promise<SessionUser> {
  const token = bearerToken(request);
  if (!token) {
    throw new AppError("unauthorized", "Sign in to continue.");
  }

  const supabase = getSupabaseServer();
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) {
    // A bad token is the caller's problem, not ours: 401, and the client
    // refreshes.
    throw new AppError("unauthorized", "Your session has expired. Sign in again.");
  }

  return { id: data.user.id, email: data.user.email ?? null };
}

/** The caller's profile row, which carries the timezone the UI must render in. */
export async function requireProfile(
  request: Request,
): Promise<SessionUser & {
  timezone: string;
  display_name: string | null;
  username: string | null;
  streak_current: number;
  avatar_path: string | null;
  share_task_titles: boolean;
}> {
  const user = await requireUser(request);
  const supabase = getSupabaseServer();
  const { data, error } = await supabase
    .from("profiles")
    .select("timezone, display_name, username, streak_current, avatar_path, share_task_titles")
    .eq("id", user.id)
    .single();

  if (error || !data) {
    throw new AppError("internal", "Your profile could not be loaded.");
  }

  return { ...user, ...data };
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const [scheme, token] = header.split(" ");
  if (!token || scheme?.toLowerCase() !== "bearer") return null;
  return token.trim() || null;
}

/**
 * A Supabase client bound to the caller's token, so RLS sees their identity.
 *
 * Note the order: this reads the *caller's* profile through the caller's own
 * client, so a participant can see the host's display name for the roster
 * (item 19) but nothing else on the host's profile.
 */
export async function getRlsClientFor(
  request: Request,
): Promise<{ supabase: SupabaseClient; user: SessionUser }> {
  const token = bearerToken(request);
  if (!token) throw new AppError("unauthorized", "Sign in to continue.");

  const { getSupabaseServerForToken } = await import("./supabase-for-token");
  const user = await requireUser(request);
  return { supabase: getSupabaseServerForToken(token), user };
}
