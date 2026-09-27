import { z } from "zod";

const schema = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  SUPABASE_ANON_KEY: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().min(1),
  PARSER_MODEL: z.string().min(1).optional(),
});

export type EdgeEnv = z.infer<typeof schema>;

let cached: EdgeEnv | null = null;

export function getEdgeEnv(): EdgeEnv {
  if (cached) return cached;
  const parsed = schema.safeParse(Deno.env.toObject());
  if (!parsed.success) {
    throw new Error(
      `Invalid edge env: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`,
    );
  }
  cached = parsed.data;
  return cached;
}

export function edgeParserModel(): string {
  return getEdgeEnv().PARSER_MODEL ?? "claude-opus-5-20250915";
}
