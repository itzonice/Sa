import { describe, expect, it } from "vitest";
import {
  describePresence,
  evaluateNudge,
  IDLE_AFTER_MS,
  idleForMs,
  isIdle,
  mergePresence,
  NUDGE_LIMIT_PER_SESSION,
  nudgeDisabledReason,
  type PresenceEntry,
} from "./presence";

const T0 = 1_800_000_000_000;

function entry(overrides: Partial<PresenceEntry> = {}): PresenceEntry {
  return {
    userId: "buddy-1",
    displayName: "Rui",
    role: "buddy",
    lastActiveAtMs: T0,
    online: true,
    ...overrides,
  };
}

describe("mergePresence", () => {
  it("prefers realtime for liveness and the later heartbeat for the timestamp", () => {
    const realtime = [entry({ lastActiveAtMs: T0 - 60_000, online: true })];
    const persisted = [entry({ lastActiveAtMs: T0, online: false })];

    const [merged] = mergePresence(realtime, persisted);

    // Realtime says the socket is up; the durable heartbeat is newer, so it wins
    // on the timestamp.
    expect(merged?.online).toBe(true);
    expect(merged?.lastActiveAtMs).toBe(T0);
  });

  it("never moves lastActiveAt backwards", () => {
    const realtime = [entry({ lastActiveAtMs: T0 - 120_000 })];
    const persisted = [entry({ lastActiveAtMs: T0 })];

    expect(mergePresence(realtime, persisted)[0]?.lastActiveAtMs).toBe(T0);
  });

  it("keeps a persisted buddy who has no live socket, marked away", () => {
    const merged = mergePresence([], [entry({ online: false })]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.online).toBe(false);
  });

  it("includes the host, who has no participant row", () => {
    const host = entry({ userId: "host-1", role: "host", displayName: "Ana" });
    expect(mergePresence([host], [])).toHaveLength(1);
  });

  it("deduplicates by user and sorts by activity", () => {
    const realtime = [
      entry({ userId: "a", lastActiveAtMs: T0 - 5_000 }),
      entry({ userId: "b", lastActiveAtMs: T0 - 90_000 }),
    ];
    const persisted = [entry({ userId: "a", lastActiveAtMs: T0 - 5_000 })];

    const merged = mergePresence(realtime, persisted);

    expect(merged.map((e) => e.userId)).toEqual(["b", "a"]);
  });
});

describe("idleForMs / isIdle", () => {
  it("measures against the server clock, not the local one", () => {
    const buddy = entry({ lastActiveAtMs: T0 });
    expect(idleForMs(buddy, T0 + IDLE_AFTER_MS)).toBe(IDLE_AFTER_MS);
    expect(isIdle(buddy, T0 + IDLE_AFTER_MS)).toBe(true);
  });

  it("is not idle one millisecond before the threshold", () => {
    const buddy = entry({ lastActiveAtMs: T0 });
    expect(isIdle(buddy, T0 + IDLE_AFTER_MS - 1)).toBe(false);
  });

  it("never reports negative idle time after a clock step", () => {
    const buddy = entry({ lastActiveAtMs: T0 + 10_000 });
    expect(idleForMs(buddy, T0)).toBe(0);
  });

  it("uses a ten minute threshold", () => {
    expect(IDLE_AFTER_MS).toBe(10 * 60_000);
  });
});

describe("describePresence", () => {
  it("says here, then minutes, then away", () => {
    expect(describePresence(entry({ lastActiveAtMs: T0 }), T0 + 30_000)).toBe("here");
    expect(describePresence(entry({ lastActiveAtMs: T0 }), T0 + 4 * 60_000)).toBe(
      "here - 4 min ago",
    );
    expect(describePresence(entry({ lastActiveAtMs: T0, online: false }), T0)).toBe("away");
  });
});

describe("evaluateNudge", () => {
  it("allows a nudge once a buddy has been idle for ten minutes", () => {
    const state = evaluateNudge({
      viewerId: "host-1",
      target: entry({ lastActiveAtMs: T0 }),
      sentCount: 0,
      serverNowMs: T0 + IDLE_AFTER_MS,
    });

    expect(state.eligible).toBe(true);
    expect(state.reason).toBe("ok");
    expect(state.remaining).toBe(NUDGE_LIMIT_PER_SESSION);
  });

  it("refuses before the threshold", () => {
    const state = evaluateNudge({
      viewerId: "host-1",
      target: entry({ lastActiveAtMs: T0 }),
      sentCount: 0,
      serverNowMs: T0 + IDLE_AFTER_MS - 1,
    });

    expect(state.eligible).toBe(false);
    expect(nudgeDisabledReason(state)).toContain("10 minutes");
  });

  it("stops at three per session", () => {
    const state = evaluateNudge({
      viewerId: "host-1",
      target: entry({ lastActiveAtMs: T0 }),
      sentCount: NUDGE_LIMIT_PER_SESSION,
      serverNowMs: T0 + IDLE_AFTER_MS,
    });

    expect(state.eligible).toBe(false);
    expect(state.reason).toBe("limit-reached");
    expect(nudgeDisabledReason(state)).toContain("three");
  });

  it("allows the second and third nudge", () => {
    for (const sent of [0, 1, 2]) {
      const state = evaluateNudge({
        viewerId: "host-1",
        target: entry({ lastActiveAtMs: T0 }),
        sentCount: sent,
        serverNowMs: T0 + IDLE_AFTER_MS,
      });
      expect(state.eligible).toBe(true);
      expect(state.remaining).toBe(NUDGE_LIMIT_PER_SESSION - sent);
    }
  });

  it("refuses to nudge yourself, an absent target, or a disconnected one", () => {
    const base = { viewerId: "host-1", sentCount: 0, serverNowMs: T0 + IDLE_AFTER_MS };

    expect(
      evaluateNudge({ ...base, target: entry({ userId: "host-1", role: "host" }) }).reason,
    ).toBe("self");
    expect(evaluateNudge({ ...base, target: null }).reason).toBe("not-in-session");
    expect(
      evaluateNudge({ ...base, target: entry({ online: false, lastActiveAtMs: T0 }) }).reason,
    ).toBe("offline");
  });

  it("has a human reason for every outcome", () => {
    const cases = [
      evaluateNudge({ viewerId: "h", target: null, sentCount: 0, serverNowMs: T0 }),
      evaluateNudge({
        viewerId: "h",
        target: entry({ userId: "h" }),
        sentCount: 0,
        serverNowMs: T0,
      }),
      evaluateNudge({ viewerId: "h", target: entry(), sentCount: 3, serverNowMs: T0 }),
      evaluateNudge({
        viewerId: "h",
        target: entry({ online: false }),
        sentCount: 0,
        serverNowMs: T0,
      }),
      evaluateNudge({ viewerId: "h", target: entry(), sentCount: 0, serverNowMs: T0 }),
      evaluateNudge({
        viewerId: "h",
        target: entry({ lastActiveAtMs: T0 - IDLE_AFTER_MS }),
        sentCount: 0,
        serverNowMs: T0,
      }),
    ];

    for (const state of cases) {
      if (state.eligible) continue;
      expect(nudgeDisabledReason(state)).toBeTruthy();
    }
  });
});
