import "server-only";

import {
  checkRateLimit,
  nextBucket,
  RATE_LIMITS,
  type RateLimitBucket,
  type RateLimitName,
} from "@studyly/core/rate-limit";
import { AppError } from "./http/errors";

/**
 * In-memory sliding-window limiter, keyed by user then route.
 *
 * Scope, stated plainly: this is per Node process. On a single-instance
 * deployment it is a real limit; behind a multi-instance load balancer each
 * instance gets its own budget, so a caller can send N x limit. A shared limit
 * needs a Redis or Postgres counter -- until then this bounds accidents and
 * casual abuse, and the database constraints (three buddies, 23:59 default
 * deadline) remain the actual invariants.
 */
const buckets = new Map<string, number[]>();

/** Drop buckets that have not been touched in an hour. */
const SWEEP_AFTER_MS = 60 * 60_000;
let lastSweepMs = 0;

function sweep(nowMs: number): void {
  if (nowMs - lastSweepMs < SWEEP_AFTER_MS) return;
  lastSweepMs = nowMs;
  for (const [key, hits] of buckets) {
    if (hits.length === 0 || (hits[hits.length - 1] as number) + SWEEP_AFTER_MS < nowMs) {
      buckets.delete(key);
    }
  }
}

/**
 * Consumes one unit of `name`'s budget for `userId`, or throws 429 with
 * `Retry-After` (item 24).
 */
export function enforceRateLimit(userId: string, name: RateLimitName): void {
  const { limit, windowMs } = RATE_LIMITS[name];
  const nowMs = Date.now();
  sweep(nowMs);

  const key = `${name}:${userId}`;
  const bucket = (buckets.get(key) ?? []) as RateLimitBucket;
  const options = { limit, windowMs, nowMs };
  const decision = checkRateLimit(bucket, options);

  if (decision.limited) {
    throw new AppError("rate_limited", "Slow down a moment.", {
      retryAfterSeconds: decision.retryAfterSeconds,
    });
  }

  buckets.set(key, [...nextBucket(bucket, options), nowMs]);
}

/** Test-only: drops all recorded state. */
export function resetRateLimitsForTests(): void {
  buckets.clear();
  lastSweepMs = 0;
}
