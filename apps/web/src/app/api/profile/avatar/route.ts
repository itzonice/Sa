import { requireUser, getRlsClientFor } from "@/lib/auth";
import { enforceRateLimit } from "@/lib/rate-limit";
import { AppError } from "@/lib/http/errors";
import { route, jsonOk } from "@/lib/http/respond";
import {
  AVATAR_BUCKET,
  AVATAR_SIGNED_URL_TTL_SECONDS,
  MAX_AVATAR_BYTES,
  avatarFileSchema,
  avatarPathFor,
  isOwnAvatarPath,
} from "@studyly/core/identity";

/**
 * POST /api/profile/avatar — accept the settings form's multipart upload.
 *
 * The bucket is private and Storage enforces `file_size_limit` and
 * `allowed_mime_types` (migration 0013), but the expensive failure is the one
 * the user waits through, so the file is validated here before a single byte
 * leaves the browser: `avatarFileSchema` rejects empty, oversize and
 * wrong-type files with a message the form can show.
 *
 * The upload goes through the caller's own JWT (RLS-scoped Storage policies,
 * migration 0013) to the one canonical key `<uid>/avatar.<ext>`, so a second
 * upload replaces the old image instead of accumulating orphans. The path is
 * then recorded through `public.set_avatar_path`, the only write path to
 * `profiles.avatar_path`, which refuses any key outside the caller's own
 * folder.
 */
export const POST = route("profile/avatar", async (request, requestId) => {
  const user = await requireUser(request);
  enforceRateLimit(user.id, "avatarUpload");

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw new AppError("bad_request", "Expected a multipart form with a file field.");
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    throw new AppError("bad_request", "Attach an image in the file field.");
  }

  const parsedFile = avatarFileSchema.safeParse({ size: file.size, type: file.type });
  if (!parsedFile.success) {
    throw new AppError(
      "bad_request",
      parsedFile.error.issues[0]?.message ?? "That file cannot be an avatar.",
    );
  }

  const path = avatarPathFor(user.id, file.type);
  if (!path) {
    throw new AppError("bad_request", "Unsupported image type.");
  }

  const { supabase } = await getRlsClientFor(request);

  const { error: uploadError } = await supabase.storage
    .from(AVATAR_BUCKET)
    .upload(path, file, {
      cacheControl: "300",
      upsert: true,
      contentType: file.type,
    });

  if (uploadError) {
    // Storage rejects oversize/mime violations before anything is written; map
    // that to the same message the pre-validation would have given.
    throw new AppError(
      "bad_request",
      `Upload failed: ${uploadError.message} (max ${Math.floor(MAX_AVATAR_BYTES / (1024 * 1024))} MB, PNG/JPEG/WebP).`,
    );
  }

  const { error: pathError } = await supabase.rpc("set_avatar_path", {
    p_avatar_path: path,
  });

  if (pathError) {
    throw new AppError("internal", "Upload succeeded but the profile could not be updated.");
  }

  const { data: signed } = await supabase.storage
    .from(AVATAR_BUCKET)
    .createSignedUrl(path, AVATAR_SIGNED_URL_TTL_SECONDS);

  return jsonOk(
    {
      avatar_path: path,
      avatar_url: signed?.signedUrl ?? null,
    },
    requestId,
  );
});

/**
 * GET /api/profile/avatar — a short-lived signed URL for the caller's avatar.
 *
 * The client stores `avatar_path`, never a URL. Signed URLs expire, so the
 * avatar is re-requested per render and the response is marked no-store: a
 * cached avatar URL outliving its signature shows up as a broken image.
 */
export const GET = route("profile/avatar", async (request, requestId) => {
  const user = await requireUser(request);

  const { supabase } = await getRlsClientFor(request);

  const { data: profile } = await supabase
    .from("profiles")
    .select("avatar_path")
    .eq("id", user.id)
    .single();

  const path = profile?.avatar_path;
  if (!path || !isOwnAvatarPath(user.id, path)) {
    return jsonOk({ avatar_url: null }, requestId);
  }

  const { data: signed } = await supabase.storage
    .from(AVATAR_BUCKET)
    .createSignedUrl(path, AVATAR_SIGNED_URL_TTL_SECONDS);

  return jsonOk({ avatar_url: signed?.signedUrl ?? null }, requestId);
});

/**
 * DELETE /api/profile/avatar — clear the avatar.
 *
 * The column goes to null first; the Storage object is removed afterwards and
 * a failed removal is not an error the user cares about (the profile already
 * points nowhere), so it is only logged by the route wrapper.
 */
export const DELETE = route("profile/avatar", async (request, requestId) => {
  const user = await requireUser(request);

  const { supabase } = await getRlsClientFor(request);

  const { data: profile } = await supabase
    .from("profiles")
    .select("avatar_path")
    .eq("id", user.id)
    .single();

  const { error: clearError } = await supabase.rpc("set_avatar_path", {
    p_avatar_path: null,
  });

  if (clearError) {
    throw new AppError("internal", "Could not clear the avatar.");
  }

  const path = profile?.avatar_path;
  if (path && isOwnAvatarPath(user.id, path)) {
    await supabase.storage.from(AVATAR_BUCKET).remove([path]);
  }

  return jsonOk({ avatar_path: null, avatar_url: null }, requestId);
});
