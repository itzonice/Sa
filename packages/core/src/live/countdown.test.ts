import { describe, expect, it } from "vitest";
import {
  CLOCK_SKEW_WARN_MS,
  clockSkewMs,
  computeCountdown,
  estimateServerNowMs,
  formatDuration,
  MAX_PLANNED_MINUTES,
  MIN_PLANNED_MINUTES,
  plannedDurationMs,
  timerStateFrom,
  type TimerState,
} from "./countdown";

const T0 = Date.parse("2026-09-27T10:00:00.000Z");

function timer(overrides: Partial<TimerState> = {}): TimerState {
  return {
    startedAtMs: T0,
    serverNowMs: T0,
    clientSyncedAtMs: 1_000,
    plannedMinutes: 25,
    ...overrides,
  };
}

describe("plannedDurationMs", () => {
  it("converts minutes to milliseconds", () => {
    expect(plannedDurationMs(25)).toBe(25 * 60_000);
  });
});

describe("estimateServerNowMs", () => {
  it("advances the server clock by the same amount the local clock advanced", () => {
    // Device clock is 5 minutes fast; 30s of local time is still 30s of time.
    const state = timer({ serverNowMs: T0, clientSyncedAtMs: 0 });
    expect(estimateServerNowMs(state, 30_000)).toBe(T0 + 30_000);
  });

  it("does not run backwards when the local clock is corrected", () => {
    // NTP steps the clock back five minutes. Showing time from before the step is
    // better than rewinding the countdown.
    const state = timer({ serverNowMs: T0, clientSyncedAtMs: 10_000 });
    expect(estimateServerNowMs(state, 0)).toBe(T0);
  });
});

describe("computeCountdown", () => {
  it("counts down the planned block", () => {
    const state = timer();
    const tenMinutesIn = computeCountdown(state, 1_000 + 10 * 60_000);

    expect(tenMinutesIn.remainingMs).toBe(15 * 60_000);
    expect(tenMinutesIn.progress).toBeCloseTo(0.4, 5);
    expect(tenMinutesIn.overtime).toBe(false);
  });

  it("clamps remaining at zero and flags overtime past the end", () => {
    const state = timer();
    const late = computeCountdown(state, 1_000 + 30 * 60_000);

    expect(late.remainingMs).toBe(0);
    expect(late.overtime).toBe(true);
    expect(late.progress).toBe(1);
  });

  /**
   * Item 14 is the whole point of this test: two clients with badly wrong clocks
   * must still agree on what the timer says, because both are anchored to the
   * same server instant.
   */
  it("gives two clients with different clocks the same answer", () => {
    const startedAt = new Date(T0).toISOString();
    const serverNow = T0 + 8 * 60_000;
    const serverNowIso = new Date(serverNow).toISOString();

    // Device A's clock is right; device B's is 90 minutes fast. Both were handed
    // the same server answer at the same moment.
    const accurate = timerStateFrom({
      startedAt,
      plannedMinutes: 25,
      serverNow: serverNowIso,
      clientNowMs: serverNow,
    });
    const skewed = timerStateFrom({
      startedAt,
      plannedMinutes: 25,
      serverNow: serverNowIso,
      clientNowMs: serverNow + 90 * 60_000,
    });

    // ...and a second later, each according to its own clock.
    const a = computeCountdown(accurate, serverNow + 1_000);
    const b = computeCountdown(skewed, serverNow + 90 * 60_000 + 1_000);

    expect(b.remainingMs).toBe(a.remainingMs);
    expect(formatDuration(b.remainingMs)).toBe(formatDuration(a.remainingMs));

    // The drift is still detectable, which is what drives the "check your clock"
    // hint -- but it cannot make the timer disagree with the host's.
    expect(clockSkewMs(skewed, serverNow + 90 * 60_000)).toBe(90 * 60_000);
    expect(clockSkewMs(accurate, serverNow)).toBe(0);
    expect(clockSkewMs(skewed, serverNow + 90 * 60_000 + 1_000)).toBeGreaterThan(
      CLOCK_SKEW_WARN_MS,
    );
  });

  it("never reports negative progress for a session that has not started", () => {
    const state = timer({ startedAtMs: T0 + 60_000, serverNowMs: T0, clientSyncedAtMs: 0 });
    const early = computeCountdown(state, 0);

    expect(early.remainingMs).toBe(plannedDurationMs(25));
    expect(early.progress).toBe(0);
  });
});

describe("formatDuration", () => {
  it("formats mm:ss under an hour and h:mm:ss above", () => {
    expect(formatDuration(0)).toBe("00:00");
    expect(formatDuration(65_000)).toBe("01:05");
    expect(formatDuration(25 * 60_000)).toBe("25:00");
    expect(formatDuration(65 * 60_000)).toBe("1:05:00");
  });

  it("treats negative input as zero rather than printing NaN", () => {
    expect(formatDuration(-5_000)).toBe("00:00");
  });
});

describe("planned minute bounds", () => {
  it("matches the database check constraint of 5 to 480", () => {
    expect(MIN_PLANNED_MINUTES).toBe(5);
    expect(MAX_PLANNED_MINUTES).toBe(480);
  });
});
