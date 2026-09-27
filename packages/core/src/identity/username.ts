import { z } from "zod";

/**
 * Public usernames.
 *
 * A username is the only public handle. Email addresses are never stored on
 * `profiles` and never leave `auth.users`, so nothing here ever needs one: the
 * signup path derives a username from the email local part and then forgets the
 * email.
 *
 * The character set is `[a-z0-9_]` and nothing else -- no hyphens, no dots, no
 * uppercase. That is a deliberate narrowing: it removes every confusable pair
 * (l/1, 0/o, rn/m) that a hand-typed handle invites, and it means the stored
 * value is already case-folded, so uniqueness and lookup agree by construction.
 *
 * Mirrored in SQL by `public.slug_from_email` and `public.allocate_username` in
 * migration 0012. The two implementations have to agree, so both sides carry the
 * same table of cases in their tests.
 */

export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 20;

export const usernamePattern = /^[a-z0-9_]{3,20}$/;

/**
 * Reserved because a route or a support process could plausibly be addressed as
 * one of them. Not an authentication surface, just a way to keep impersonating
 * "admin" from being trivially easy.
 */
export const RESERVED_USERNAMES = [
  "admin",
  "administrator",
  "api",
  "app",
  "help",
  "root",
  "support",
  "system",
  "user",
] as const;

export const usernameSchema = z
  .string()
  .min(USERNAME_MIN_LENGTH, "Pick at least 3 characters.")
  .max(USERNAME_MAX_LENGTH, "Keep it to 20 characters or fewer.")
  .regex(usernamePattern, "Use lowercase letters, numbers and underscores only.")
  .refine((value) => !value.startsWith("_") && !value.endsWith("_"), {
    message: "Usernames cannot start or end with an underscore.",
  })
  .refine((value) => !(RESERVED_USERNAMES as readonly string[]).includes(value), {
    message: "That username is reserved.",
  });

/** Parse and return the canonical form, or null if the input is not a username. */
export function parseUsername(value: unknown): string | null {
  const result = usernameSchema.safeParse(value);
  return result.success ? result.data : null;
}

/**
 * Case-folds and collapses anything a person might type into the stored form.
 *
 * This is what makes "case-insensitive" true end to end: `"  Ana  "` and
 * `"ana"` both normalise to `"ana"`, and since storage is lowercase-only the
 * unique index and every lookup agree.
 */
export function normalizeUsername(value: string): string {
  return value.trim().toLowerCase();
}

export function isValidUsername(value: unknown): boolean {
  return usernameSchema.safeParse(value).success;
}

/**
 * Derives a username candidate from an email address.
 *
 * Only the local part is used, and the result is a *candidate*, not a promise:
 * `"ada.lovelace+dev@x.com"` becomes `"ada_lovelace_dev"`, which somebody may
 * already hold. Returns null for input with no usable local part, so the caller
 * has to decide the fallback rather than getting a silently empty string.
 */
export function slugifyEmailLocalPart(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at <= 0) return null;

  const localPart = email.slice(0, at).toLowerCase();
  const folded = localPart
    // Split on runs of disallowed characters so "ada.lovelace" and
    // "ada--lovelace" both collapse to single underscores.
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");

  if (folded.length === 0) return null;
  return truncateUsername(folded, 0);
}

/**
 * Shortens a base to fit the length budget once a numeric suffix is added.
 *
 * `budget` is the number of characters the suffix will occupy: 0 for the first
 * try, then the length of `"_2"`, `"_3"` and so on. Truncating *before* appending
 * is what keeps `base_2` inside the 20-character limit instead of overflowing
 * it.
 */
export function truncateUsername(base: string, suffixLength: number): string {
  const budget = USERNAME_MAX_LENGTH - suffixLength;
  if (budget < USERNAME_MIN_LENGTH) {
    throw new Error("suffix does not leave room for a username");
  }
  return base.slice(0, budget);
}

/**
 * The ordered candidates an allocator tries: `base`, `base_2`, `base_3`, ...
 *
 * Note the underscore: the character set in the spec is `[a-z0-9_]`, so a hyphen
 * is not available as a suffix separator. See the note in the migration.
 */
export function usernameCandidates(base: string, maxAttempts = 50): string[] {
  const candidates: string[] = [truncateUsername(base, 0)];
  for (let attempt = 2; attempt <= maxAttempts; attempt += 1) {
    const suffix = `_${attempt}`;
    if (USERNAME_MAX_LENGTH - suffix.length < USERNAME_MIN_LENGTH) break;
    candidates.push(truncateUsername(base, suffix.length) + suffix);
  }
  return candidates;
}

/**
 * Picks a username for a new account.
 *
 * `taken` answers "does anybody hold this?", and the first candidate it does not
 * is returned. In the app the real `taken` is the unique index, which is also
 * why the SQL side loops on `unique_violation` rather than trusting a prior read.
 */
export function allocateUsername(
  base: string,
  taken: (candidate: string) => boolean,
  maxAttempts = 50,
): string | null {
  for (const candidate of usernameCandidates(base, maxAttempts)) {
    if (!isValidUsername(candidate)) continue;
    if (RESERVED_USERNAMES.includes(candidate as (typeof RESERVED_USERNAMES)[number])) continue;
    if (!taken(candidate)) return candidate;
  }
  return null;
}

/** A fallback when the email local part yields nothing usable, e.g. `"@x.com"`. */
export function fallbackUsernameBase(randomDigits: () => number): string {
  const digits = Math.floor(randomDigits() * 1000)
    .toString()
    .padStart(3, "0");
  return `user${digits}`;
}
