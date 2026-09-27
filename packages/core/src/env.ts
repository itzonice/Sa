import { z } from "zod";

/**
 * Zod-validated env for apps/web and any Node context.
 * Access only through `getEnv()`; never read process.env directly in app code.
 */

const bool = (v: string | undefined) => v === "1" || v?.toLowerCase() === "true";

/**
 * The subset that may cross into the browser.
 *
 * `getEnv()` reads `process.env`, which on the client only contains inlined
 * `NEXT_PUBLIC_*` values -- so a Client Component calling it for SUPABASE_URL
 * would see `undefined`. Everything here is validated against the public names,
 * and no secret may be added to it.
 */
const publicSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  NEXT_PUBLIC_APP_URL: z.string().url().default("http://localhost:3000"),
  NEXT_PUBLIC_POSTHOG_KEY: z.string().min(1).optional(),
  NEXT_PUBLIC_POSTHOG_HOST: z.string().url().optional(),
  /** Item 1: zod-validated, no default. Unset means "no DSN, errors stay local". */
  NEXT_PUBLIC_SENTRY_DSN: z.string().url().optional(),
});

const schema = publicSchema.extend({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(1),
  /**
   * Only needed by `supabase-admin.ts` (deletion, export, cron). Optional so a
   * deployment without it still boots; the admin client raises a named error
   * when it is actually used.
   */
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
  SENTRY_AUTH_TOKEN: z.string().min(1).optional(),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  PARSER_MODEL: z.string().min(1).optional(),
  POSTHOG_KEY: z.string().min(1).optional(),
  POSTHOG_HOST: z.string().url().optional(),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

export function getEnv(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment configuration: ${missing}`);
  }
  cached = parsed.data;
  return cached;
}

export type PublicEnv = z.infer<typeof publicSchema>;

let cachedPublic: PublicEnv | null = null;

export function getPublicEnv(): PublicEnv {
  if (cachedPublic) return cachedPublic;
  const parsed = publicSchema.safeParse(process.env);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid public environment configuration: ${missing}`);
  }
  cachedPublic = parsed.data;
  return cachedPublic;
}

/** Test seams so a suite can assert on a fresh parse after mutating env. */
export function resetEnvCacheForTests(): void {
  cached = null;
  cachedPublic = null;
}

export const isProd = () => getEnv().NODE_ENV === "production";
export const isTest = () => bool(process.env.VITEST) || getEnv().NODE_ENV === "test";

export function requireApiKey(): string {
  const key = getEnv().ANTHROPIC_API_KEY;
  if (!key) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set — required for the syllabus parser. See .env.example.",
    );
  }
  return key;
}

export function parserModel(): string {
  return getEnv().PARSER_MODEL ?? "claude-opus-5-20250915";
}
