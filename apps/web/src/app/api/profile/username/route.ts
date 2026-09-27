import { z } from "zod";
import { requireUser, getRlsClientFor } from "@/lib/auth";
import { enforceRateLimit } from "@/lib/rate-limit";
import { AppError } from "@/lib/http/errors";
import { route, jsonOk, parseJsonBody } from "@/lib/http/respond";
import {
  usernameSchema,
  normalizeUsername,
  RESERVED_USERNAMES,
} from "@studyly/core/identity";

/**
 * POST /api/profile/username — save the caller's public identity.
 *
 * The username goes through `public.set_username` (migration 0012), which
 * normalises, applies the same rules as the zod schema here, and treats the
 * unique index as the authority on collisions. The column grants mean that RPC
 * is the only way a username can change from a client; `update profiles set
 * username = ...` is refused before RLS even runs.
 *
 * display_name and share_task_titles are ordinary granted columns on the
 * caller's own row, so they are written directly through the RLS client —
 * still zod-validated here first, per the house rule that every boundary is.
 */

const bodySchema = z
  .object({
    username: z.string().max(100).optional(),
    display_name: z
      .string()
      .max(60, "Keep the display name to 60 characters or fewer.")
      .nullish(),
    share_task_titles: z.boolean().optional(),
  })
  .refine((body) => body.username !== undefined || body.display_name !== undefined || body.share_task_titles !== undefined, {
    message: "Nothing to update.",
  });

export const POST = route("profile/username", async (request, requestId) => {
  const user = await requireUser(request);
  enforceRateLimit(user.id, "usernameChange");

  const body = await parseJsonBody(request, bodySchema);

  const { supabase } = await getRlsClientFor(request);

  // --- username, if provided: the RPC is the only write path ---
  let username: string | null | undefined;
  if (body.username !== undefined) {
    // Zod gives the form its precise, friendly message; the reserved list is
    // checked here so an unlucky-but-valid handle fails with the right reason
    // before it reaches the database.
    const parsed = usernameSchema.safeParse(normalizeUsername(body.username));
    if (!parsed.success) {
      throw new AppError("bad_request", parsed.error.issues[0]?.message ?? "Invalid username.");
    }
    if ((RESERVED_USERNAMES as readonly string[]).includes(parsed.data)) {
      throw new AppError("conflict", "That username is reserved.");
    }

    const { data, error } = await supabase.rpc("set_username", {
      p_username: parsed.data,
    });

    if (error) {
      const message = error.message ?? "";
      if (message.includes("taken")) {
        throw new AppError("conflict", "That username is taken.");
      }
      if (message.includes("reserved")) {
        throw new AppError("conflict", "That username is reserved.");
      }
      if (message.includes("username")) {
        throw new AppError("bad_request", message);
      }
      throw new AppError("internal", "Could not save the username.");
    }
    username = typeof data === "string" ? data : parsed.data;
  }

  // --- display name / share setting: granted columns on the caller's own row ---
  const directUpdates: Record<string, string | null | boolean> = {};
  if (body.display_name !== undefined) {
    const trimmed = body.display_name?.trim() ?? "";
    directUpdates.display_name = trimmed === "" ? null : trimmed;
  }
  if (body.share_task_titles !== undefined) {
    directUpdates.share_task_titles = body.share_task_titles;
  }

  if (Object.keys(directUpdates).length > 0) {
    const { error } = await supabase.from("profiles").update(directUpdates).eq("id", user.id);
    if (error) {
      throw new AppError("internal", "Could not save your profile.");
    }
  }

  // Read back through RLS so the response is what the database actually holds.
  const { data: row, error: rowError } = await supabase
    .from("profiles")
    .select("username, display_name, share_task_titles")
    .eq("id", user.id)
    .single();

  if (rowError || !row) {
    throw new AppError("internal", "Could not confirm your profile.");
  }

  return jsonOk(
    {
      username: row.username,
      display_name: row.display_name,
      share_task_titles: row.share_task_titles,
      ...(username !== undefined ? { username } : {}),
    },
    requestId,
  );
});
