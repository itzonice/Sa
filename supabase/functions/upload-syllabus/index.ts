/**
 * Item 17: upload-syllabus edge function.
 * - Verifies the caller's JWT and ownership
 * - Validates file type/size (or pasted text / URL source)
 * - Creates a syllabus_uploads row
 * - Runs the parse (extract -> AI parse -> postprocess) and stores the result
 *
 * POST { source: { kind: "file"|"text"|"url", ... }, term_start?, term_end? }
 * Auth: Bearer JWT (anon+user). Storage path: `${uid}/${uploadId}.pdf`.
 */

import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { getEdgeEnv, edgeParserModel } from "../_shared/env.ts";
import {
  postprocess,
  fetchSyllabusText,
  extractTextFromPdf,
  setPdfExtractor,
} from "@studyly/core/parser";

const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20 MiB
const ALLOWED_TYPES = ["application/pdf", "text/plain"];

const bodySchema = z.object({
  source: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("file"), storage_path: z.string().min(1) }),
    z.object({ kind: z.literal("text"), text: z.string().min(20).max(500_000) }),
    z.object({ kind: z.literal("url"), url: z.string().url() }),
  ]),
  term_start: z.string().date().optional(),
  term_end: z.string().date().optional(),
  timezone: z.string().min(1).optional(),
});

Deno.serve(async (req) => {
  const authHeader = req.headers.get("Authorization") ?? "";
  const env = getEdgeEnv();
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: authData } = await supabase.auth.getUser(authHeader.replace("Bearer ", ""));
  const user = authData?.user;
  if (!user) {
    return json({ error: "Unauthorized" }, 401);
  }

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await req.json());
  } catch (err) {
    return json({ error: `Invalid request: ${err instanceof Error ? err.message : err}` }, 400);
  }

  // Timezone from profile (fallback: body or UTC) — profile is the source of truth.
  let timezone = body.timezone ?? "UTC";
  {
    const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
    const { data: profile } = await sb
      .from("profiles")
      .select("timezone")
      .eq("id", user.id)
      .single();
    if (profile?.timezone) timezone = profile.timezone;
  }

  // Create the upload row first (status pending).
  const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: uploadRow, error: insertErr } = await admin
    .from("syllabus_uploads")
    .insert({
      owner_id: user.id,
      storage_path:
        body.source.kind === "file" ? body.source.storage_path : `inline/${crypto.randomUUID()}`,
      source_kind: body.source.kind,
      status: "parsing",
      prompt_version: "v1",
    })
    .select("id")
    .single();

  if (insertErr || !uploadRow) {
    return json({ error: `Could not create upload: ${insertErr?.message}` }, 500);
  }
  const uploadId = uploadRow.id as string;

  try {
    // ---- Extract text (items 18, 19) ----
    let text: string;
    if (body.source.kind === "text") {
      text = body.source.text;
    } else if (body.source.kind === "url") {
      text = await fetchSyllabusText(body.source.url);
    } else {
      // File from storage — verify ownership: path must start with the uid folder.
      if (!body.source.storage_path.startsWith(`${user.id}/`)) {
        return json({ error: "Forbidden: storage path does not belong to caller" }, 403);
      }
      const { data: blob, error: dlErr } = await admin.storage
        .from("syllabi")
        .download(body.source.storage_path);
      if (dlErr || !blob) {
        throw new Error(`Could not download file: ${dlErr?.message}`);
      }
      if (blob.size > MAX_FILE_BYTES) {
        throw new Error(`File exceeds ${MAX_FILE_BYTES} bytes`);
      }
      const buf = new Uint8Array(await blob.arrayBuffer());
      if (!ALLOWED_TYPES.includes(blob.type) && !body.source.storage_path.endsWith(".pdf")) {
        throw new Error(`Unsupported file type: ${blob.type || "unknown"}`);
      }
      setPdfExtractor(pdfTextExtractor());
      text = extractTextFromPdf(buf).text;
    }

    // ---- Parse (item 21) ----
    const { parseSyllabus } = await import("@studyly/core/parser");
    const outcome = await parseSyllabus({
      text,
      timezone,
      term_start: body.term_start,
      term_end: body.term_end,
    });

    if (!outcome.ok) {
      await admin
        .from("syllabus_uploads")
        .update({ status: "failed", error: outcome.error })
        .eq("id", uploadId);
      return json({ upload_id: uploadId, status: "failed", error: outcome.error }, 422);
    }

    // ---- Postprocess (items 22-24) ----
    const { postprocess: pp } = await import("@studyly/core/parser");
    const processed = pp(outcome.result, {
      timezone,
      term_start: body.term_start,
      term_end: body.term_end,
    });

    await admin
      .from("syllabus_uploads")
      .update({
        status: "parsed",
        parse_result: {
          ...processed,
          prompt_version: outcome.promptVersion,
          model: outcome.model ?? edgeParserModel(),
        },
      })
      .eq("id", uploadId);

    return json({ upload_id: uploadId, status: "parsed", warnings: processed.warnings });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await admin
      .from("syllabus_uploads")
      .update({ status: "failed", error: message })
      .eq("id", uploadId);
    return json({ upload_id: uploadId, status: "failed", error: message }, 500);
  }
});

/** Lazy unpdf wiring — runs only when a file is actually processed. */
function pdfTextExtractor() {
  return (buf: Uint8Array): string[] => {
    // unpdf is bundled in the edge deploy; dynamic import keeps cold start fast.
    // deno-lint-ignore no-explicit-any
    const unpdf = (globalThis as any).__unpdf;
    if (!unpdf) {
      throw new Error("unpdf not wired in edge bundle; add to import map");
    }
    return unpdf.extractText(buf) as string[];
  };
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
