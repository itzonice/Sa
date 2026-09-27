import { z } from "zod";
import { parseUsername } from "./username";

/**
 * Avatars: a private Storage bucket, one object per user, read with short-lived
 * signed URLs.
 *
 * The bucket is private, so `avatar_path` on `profiles` is an *internal* key and
 * must never be rendered directly into an `<img src>`. Nothing public should ever
 * contain the raw path; the server mints a signed URL per request. The path
 * itself is still user-shaped (`<uid>/avatar.<ext>`) so the Storage RLS policies
 * can scope reads and writes to the owner by first path segment.
 */

export const AVATAR_BUCKET = "avatars";

/** 2 MiB. An avatar is a thumbnail; a 12 MP phone photo does not belong here. */
export const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

export const ALLOWED_AVATAR_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;

export type AllowedAvatarType = (typeof ALLOWED_AVATAR_TYPES)[number];

/**
 * Five minutes. Long enough that a page of avatars does not expire mid-scroll,
 * short enough that a URL pasted into a chat window dies quickly.
 */
export const AVATAR_SIGNED_URL_TTL_SECONDS = 300;

const EXTENSION_BY_TYPE: Record<AllowedAvatarType, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

export const AVATAR_EXTENSIONS = ["png", "jpg", "webp"] as const;

export function isAllowedAvatarType(value: string): value is AllowedAvatarType {
  return (ALLOWED_AVATAR_TYPES as readonly string[]).includes(value);
}

export function avatarExtensionFor(mimeType: string): string | null {
  return isAllowedAvatarType(mimeType) ? EXTENSION_BY_TYPE[mimeType] : null;
}

/**
 * The single canonical object key for a user: `<uid>/avatar.<ext>`.
 *
 * One fixed filename, so replacing an avatar overwrites the previous object
 * instead of accumulating orphans, and the count of objects in the bucket is
 * bounded by the number of users.
 */
export function avatarPathFor(userId: string, mimeType: string): string | null {
  const extension = avatarExtensionFor(mimeType);
  if (!extension) return null;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) {
    return null;
  }
  return `${userId}/avatar.${extension}`;
}

/**
 * Whether a path is the caller's own avatar.
 *
 * Compared literally rather than with a regex built from the user id: an id
 * interpolated into a pattern turns `.` into a wildcard, which is exactly the
 * kind of bug that lets one user point at another's object.
 */
export function isOwnAvatarPath(userId: string, path: unknown): boolean {
  if (typeof path !== "string") return false;

  const prefix = `${userId}/avatar.`;
  if (!path.startsWith(prefix)) return false;

  const extension = path.slice(prefix.length);
  return (AVATAR_EXTENSIONS as readonly string[]).includes(extension);
}

/** Zod wrapper over the same predicate, for use at a request boundary. */
export function avatarPathSchema(userId: string) {
  return z
    .string()
    .min(1)
    .max(200)
    .refine((path) => isOwnAvatarPath(userId, path), {
      message: "An avatar path must be your own avatar file.",
    });
}

/**
 * The web form's file field.
 *
 * Validated before a single byte is uploaded, because a rejected upload still
 * costs bandwidth. `File` is a browser type, so this is a structural check on
 * `{ size, type }` and stays testable in Node.
 */
export const avatarFileSchema = z
  .object({
    size: z.number().int().nonnegative(),
    type: z.string(),
  })
  .refine((file) => file.size > 0, { message: "That file is empty." })
  .refine((file) => file.size <= MAX_AVATAR_BYTES, {
    message: `Avatars must be ${MAX_AVATAR_BYTES / (1024 * 1024)} MB or smaller.`,
  })
  .refine((file) => isAllowedAvatarType(file.type), {
    message: "Avatars must be a PNG, JPEG or WebP image.",
  });

export type AvatarFile = z.infer<typeof avatarFileSchema>;

/** The decoded result of a file field, or null when it was rejected. */
export function parseAvatarFile(value: unknown): AvatarFile | null {
  const result = avatarFileSchema.safeParse(value);
  return result.success ? result.data : null;
}

/** Convenience for the UI: a display name, falling back to the public username. */
export function profileLabel(input: {
  display_name?: string | null;
  username?: string | null;
}): string {
  const displayName = input.display_name?.trim();
  if (displayName) return displayName;
  return parseUsername(input.username) ?? "Someone";
}
