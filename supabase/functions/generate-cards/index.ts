/**
 * Item 39: generate-cards edge function.
 * User notes -> atomic retrieval cards via Claude, zod-validated.
 * POST { assignment_id?, course_id, notes }
 */

import Anthropic from "npm:@anthropic-ai/sdk@^0.30.0";
import { z } from "zod";
import { getEdgeEnv, edgeParserModel } from "../_shared/env.ts";
import { cardGenerationResultSchema, cardGenerationPrompt } from "@studyly/core/cards";

const bodySchema = z.object({
  course_id: z.string().uuid(),
  assignment_id: z.string().uuid().nullish(),
  notes: z.string().min(20).max(50_000),
});

const toolSchema = {
  name: "emit_cards",
  description: "Emit the generated retrieval cards",
  // deno-lint-ignore no-explicit-any
  input_schema: { type: "object" } as any,
};

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const env = getEdgeEnv();
  const authHeader = req.headers.get("Authorization") ?? "";
  const supabase = createClientFactory(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, authHeader);

  const { data: userData } = await supabase.auth.getUser(authHeader.replace("Bearer ", ""));
  const user = userData?.user;
  if (!user) return json({ error: "Unauthorized" }, 401);

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await req.json());
  } catch (err) {
    return json({ error: `Invalid request: ${err instanceof Error ? err.message : err}` }, 400);
  }

  const admin = createClientFactory(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, "");

  // Verify the course belongs to the caller (RLS helper equivalent).
  const { data: course } = await admin
    .from("courses")
    .select("id, owner_id")
    .eq("id", body.course_id)
    .single();
  if (!course || course.owner_id !== user.id) {
    return json({ error: "Course not found" }, 404);
  }

  try {
    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, timeout: 60_000 });
    const response = await client.messages.create({
      model: edgeParserModel(),
      max_tokens: 4_000,
      system: cardGenerationPrompt,
      messages: [{ role: "user", content: body.notes }],
      tools: [toolSchema],
      tool_choice: { type: "tool", name: "emit_cards" },
    });

    const block = response.content.find((b) => b.type === "tool_use");
    if (!block || block.type !== "tool_use") {
      return json({ error: "Model did not return cards" }, 502);
    }

    const parsed = cardGenerationResultSchema.safeParse(block.input);
    if (!parsed.success) {
      return json({ error: `Model output failed validation: ${parsed.error.message}` }, 502);
    }

    // Persist cards (RLS: study_cards owner-only; insert via service role after checks).
    const rows = parsed.data.cards.map((c) => ({
      owner_id: user.id,
      course_id: body.course_id,
      assignment_id: body.assignment_id ?? null,
      question: c.question,
      answer: c.answer,
      source_note: null,
      tags: c.tags,
    }));
    const { error: insertErr } = await admin.from("study_cards").insert(rows);
    if (insertErr) {
      return json({ error: `Insert failed: ${insertErr.message}` }, 500);
    }

    return json({ cards_created: rows.length });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : "Card generation failed" }, 500);
  }
});

function createClientFactory(url: string, key: string, auth: string) {
  // Inline import to avoid top-level await issues in some runtimes.
  const mod = globalThis as unknown as {
    __supabaseJs?: typeof import("@supabase/supabase-js");
  };
  if (!mod.__supabaseJs) {
    throw new Error("supabase-js not wired in edge bundle; add to import map");
  }
  return mod.__supabaseJs.createClient(url, key, {
    global: { headers: auth ? { Authorization: auth } : {} },
  });
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
