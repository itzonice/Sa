/**
 * Item 12: join codes.
 *
 * The alphabet drops I/O/0/1 so a code read aloud over voice survives the trip,
 * and the length is bounded to match the `live_sessions_code_format` check
 * constraint in 0008.
 */

export const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export const MIN_CODE_LENGTH = 4;
export const MAX_CODE_LENGTH = 10;

const CODE_PATTERN = new RegExp(`^[${CODE_ALPHABET}]{${MIN_CODE_LENGTH},${MAX_CODE_LENGTH}}$`);

export function normalizeCode(raw: string): string {
  return raw.trim().toUpperCase();
}

export function isValidCode(raw: string): boolean {
  return CODE_PATTERN.test(normalizeCode(raw));
}

/**
 * Uniform sampling over the alphabet.
 *
 * `Math.random() % 31` is biased towards the first few characters, which is
 * exactly the skew that makes a "random" six-character code guessable, so this
 * rejects the biased tail of the 2^32 range instead.
 */
export function generateCode(length: number, random: () => number = Math.random): string {
  if (!Number.isInteger(length) || length < MIN_CODE_LENGTH || length > MAX_CODE_LENGTH) {
    throw new RangeError(
      `code length must be an integer between ${MIN_CODE_LENGTH} and ${MAX_CODE_LENGTH}, got ${length}`,
    );
  }

  const size = CODE_ALPHABET.length;
  const limit = Math.floor(0x1_0000_0000 / size) * size;
  let out = "";

  while (out.length < length) {
    const draw = Math.floor(random() * 0x1_0000_0000);
    if (draw >= limit) continue; // biased tail: redraw
    out += CODE_ALPHABET[draw % size];
  }

  return out;
}

/** Item 21: the presence channel name, and its inverse in SQL. */
export function liveSessionTopic(sessionId: string): string {
  return `session:${sessionId}`;
}

export function liveSessionIdFromTopic(topic: string): string | null {
  const match = /^session:([0-9a-fA-F-]{36})$/.exec(topic);
  return match?.[1] ?? null;
}
