import { describe, expect, it } from "vitest";
import { checkRateLimit, nextBucket, RATE_LIMITS } from "./rate-limit";

const T0 = 1_700_000_000_000;

describe("checkRateLimit", () => {
  it("allows requests up to the limit and then blocks", () => {
    const opts = { limit: 3, windowMs: 60_000, nowMs: T0 };
    let bucket: number[] = [];

    for (let i = 0; i < 3; i += 1) {
      const decision = checkRateLimit(bucket, opts);
      expect(decision.limited).toBe(false);
      expect(decision.remaining).toBe(2 - i);
      bucket = [...nextBucket(bucket, opts), opts.nowMs];
    }

    const blocked = checkRateLimit(bucket, opts);
    expect(blocked.limited).toBe(true);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfterSeconds).toBe(60);
  });

  it("does not count a rejected request against the budget", () => {
    const opts = { limit: 1, windowMs: 1_000, nowMs: T0 };
    const bucket = [T0];
    expect(checkRateLimit(bucket, opts).limited).toBe(true);
    // A rejected hit must not be appended, or the window would keep sliding
    // forward on its own and the caller could never get back in.
    expect(nextBucket(bucket, opts)).toEqual([T0]);
  });

  it("frees a slot when the oldest hit ages out", () => {
    const limit = { limit: 2, windowMs: 10_000, nowMs: T0 };
    const bucket = [T0 - 6_000, T0 - 2_000];

    // Both hits are still inside the window: no slot left.
    expect(checkRateLimit(bucket, { ...limit, nowMs: T0 }).limited).toBe(true);

    // 5s later the window starts at T0-5000, so only the 6s-old hit is gone.
    const later = T0 + 5_000;
    const decision = checkRateLimit(bucket, { ...limit, nowMs: later });
    expect(decision.limited).toBe(false);
    expect(decision.remaining).toBe(0); // the freed slot went to this request
    expect(nextBucket(bucket, { ...limit, nowMs: later })).toEqual([T0 - 2_000]);
  });

  it("reports when an idle window resets", () => {
    const decision = checkRateLimit([], { limit: 5, windowMs: 30_000, nowMs: T0 });
    expect(decision.resetAtMs).toBe(T0 + 30_000);
  });

  it("rounds Retry-After up so a client never retries too early", () => {
    const decision = checkRateLimit([T0], { limit: 1, windowMs: 1_500, nowMs: T0 + 200 });
    expect(decision.limited).toBe(true);
    expect(decision.retryAfterSeconds).toBe(2);
  });

  it("rejects a nonsensical limit instead of failing open", () => {
    expect(() => checkRateLimit([], { limit: 0, windowMs: 1_000, nowMs: T0 })).toThrow();
  });
});

describe("RATE_LIMITS", () => {
  it("keeps presence heartbeats cheap and session creation scarce", () => {
    // The touch endpoint is called on a timer by every open session, so its
    // budget has to exceed the heartbeat rate with room to spare.
    expect(RATE_LIMITS.touch.limit).toBeGreaterThan(30);
    expect(RATE_LIMITS.create.limit).toBeLessThanOrEqual(10);
    expect(RATE_LIMITS.nudge.limit).toBeLessThanOrEqual(20);
  });
});
