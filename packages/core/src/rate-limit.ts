/**
 * Sliding-window rate limiting.
 *
 * Pure and clock-injected so the policy is unit-testable; the storage is the
 * caller's problem (see `apps/web/src/lib/rate-limit.ts` for the in-memory
 * store used in a single Next instance).
 *
 * A sliding window rather than a fixed one because the abuse we care about is
 * "send six nudges in a row", and a fixed window lets you send five at 10:00:59
 * and five more at 10:01:00.
 */

export type RateLimitDecision = {
  /**
   * Further requests that may be admitted right now, counting this one as spent.
   * So a fresh window on a limit of 3 reports 2, and the header a client sees
   * never says "3 left" and then immediately refuses.
   */
  remaining: number;
  /** Epoch ms at which the oldest hit in the window expires. */
  resetAtMs: number;
  /** Seconds to advertise in `Retry-After`; 0 when allowed. */
  retryAfterSeconds: number;
  limited: boolean;
};

/** Bucket state: the request timestamps still inside the window, ascending. */
export type RateLimitBucket = readonly number[];

export type RateLimitOptions = {
  limit: number;
  windowMs: number;
  nowMs: number;
};

export function checkRateLimit(
  bucket: RateLimitBucket,
  { limit, windowMs, nowMs }: RateLimitOptions,
): RateLimitDecision {
  if (limit <= 0) {
    throw new Error("rate limit must be positive");
  }

  const windowStart = nowMs - windowMs;
  // Drop everything that has aged out. A hit at exactly `windowStart` is already
  // outside the window, hence the strict comparison.
  const live = bucket.filter((at) => at > windowStart);

  if (live.length < limit) {
    return {
      remaining: limit - live.length - 1,
      resetAtMs: live.length === 0 ? nowMs + windowMs : (live[0] as number) + windowMs,
      retryAfterSeconds: 0,
      limited: false,
    };
  }

  // The window frees a slot when its oldest surviving hit expires.
  const resetAtMs = (live[0] as number) + windowMs;
  return {
    remaining: 0,
    resetAtMs,
    retryAfterSeconds: Math.max(1, Math.ceil((resetAtMs - nowMs) / 1000)),
    limited: true,
  };
}

/** The bucket to persist after a decision. Does not include a rejected hit. */
export function nextBucket(bucket: RateLimitBucket, { windowMs, nowMs }: RateLimitOptions) {
  const windowStart = nowMs - windowMs;
  return bucket.filter((at) => at > windowStart);
}

/** The per-route budgets used by the live session endpoints. */
export const RATE_LIMITS = {
  create: { limit: 10, windowMs: 60_000 },
  join: { limit: 20, windowMs: 60_000 },
  leave: { limit: 30, windowMs: 60_000 },
  end: { limit: 10, windowMs: 60_000 },
  touch: { limit: 60, windowMs: 60_000 },
  nudge: { limit: 20, windowMs: 60_000 },
  codeLookup: { limit: 60, windowMs: 60_000 },
  shareCard: { limit: 20, windowMs: 24 * 60 * 60 * 1000 },
  /**
   * Username claims are rare (a settings save, occasionally a signup preview)
   * but each one costs a unique-index probe, so a small window is enough.
   */
  usernameChange: { limit: 5, windowMs: 60_000 },
  /**
   * Uploads are the expensive one: each allowed request can carry a 2 MiB body
   * and a Storage round-trip. One per ten seconds, bursty to five per minute,
   * covers a user picking a better photo a few times in a row.
   */
  avatarUpload: { limit: 5, windowMs: 60_000 },
} as const satisfies Record<string, { limit: number; windowMs: number }>;

export type RateLimitName = keyof typeof RATE_LIMITS;
