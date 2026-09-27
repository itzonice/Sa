"use client";

import { useCallback, useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { getSupabaseBrowser } from "./supabase-browser";

export type SignUpOutcome = {
  /** A user-facing error message, or null on success. */
  error: string | null;
  /**
   * True when the account was created but no session exists yet because the
   * email still has to be confirmed. The caller should say so and wait --
   * the session appears (and `session` flips) the moment the user returns.
   */
  needsConfirmation: boolean;
};

/**
 * Client-side session state on top of the browser Supabase client.
 *
 * `getSupabaseBrowser()` throws on the server, so it is only ever touched
 * inside effects and event handlers -- never during render -- which keeps the
 * signed-out shell safe to prerender.
 */
export function useSession() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const supabase = getSupabaseBrowser();

    supabase.auth
      .getSession()
      .then(({ data }) => setSession(data.session))
      .finally(() => setReady(true));

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      setReady(true);
    });

    return () => subscription.unsubscribe();
  }, []);

  /** Returns an error message, or null when the session landed. */
  const signIn = useCallback(async (email: string, password: string): Promise<string | null> => {
    const supabase = getSupabaseBrowser();
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    return error?.message ?? null;
  }, []);

  const signUp = useCallback(async (email: string, password: string): Promise<SignUpOutcome> => {
    const supabase = getSupabaseBrowser();
    const { data, error } = await supabase.auth.signUp({ email, password });
    if (error) return { error: error.message, needsConfirmation: false };
    return { error: null, needsConfirmation: data.session === null };
  }, []);

  const signOut = useCallback(async () => {
    const supabase = getSupabaseBrowser();
    await supabase.auth.signOut();
  }, []);

  return { session, ready, signIn, signUp, signOut };
}
