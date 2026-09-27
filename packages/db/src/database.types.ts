/**
 * Generated types stub. Replaced by `pnpm db:types`
 * (supabase gen types) once a local Supabase is running.
 *
 * CI runs `pnpm db:types` and fails when this file is stale.
 */

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export interface Database {
  public: {
    Tables: Record<string, never>;
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}

export type Tables<T extends keyof Database["public"]["Tables"]> = never;
export type Functions<T extends keyof Database["public"]["Functions"]> = never;
