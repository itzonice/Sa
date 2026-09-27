import { describe, expect, it } from "vitest";
import { buildRecap, localDayIn, MAX_RECAP_NOTE_LENGTH } from "./recap";
import { EMPTY_STREAK, type StreakState } from "./streak";

const T0 = Date.parse("2026-09-27T10:00:00.000Z");

function recap(overrides: Partial<Parameters<typeof buildRecap>[0]> = {}) {
  return buildRecap({
    plannedMinutes: 50,
    startedAtMs: T0,
    endedAtMs: T0 + 50 * 60_000,
    streakBefore: EMPTY_STREAK,
    localDay: "2026-09-27",
    ...overrides,
  });
}

describe("buildRecap", () => {
  it("reports minutes studied and full completion", () => {
    const result = recap();

    expect(result.actualMinutes).toBe(50);
    expect(result.completionPercent).toBe(100);
    expect(result.endedEarly).toBe(false);
  });

  it("flags an early finish and scales the percentage", () => {
    const result = recap({ endedAtMs: T0 + 25 * 60_000 });

    expect(result.actualMinutes).toBe(25);
    expect(result.completionPercent).toBe(50);
    expect(result.endedEarly).toBe(true);
  });

  it("floors partial minutes", () => {
    expect(recap({ endedAtMs: T0 + 25 * 60_000 + 59_000 }).actualMinutes).toBe(25);
  });

  it("never exceeds 100 percent on an overtime session", () => {
    expect(recap({ endedAtMs: T0 + 200 * 60_000 }).completionPercent).toBe(100);
  });

  it("carries the streak forward from the pre-session state", () => {
    const before: StreakState = { current: 2, longest: 5, lastDay: "2026-09-26" };
    const result = recap({ streakBefore: before });

    expect(result.streakAfter.current).toBe(3);
    expect(result.streakAfter.longest).toBe(5);
    expect(result.streakAfter.outcome).toBe("extended");
    expect(result.streakCopy.tone).toBe("positive");
  });

  it("keeps the note private, trimmed, and length-capped", () => {
    expect(recap({ note: "  eigenvalues finally clicked  " }).note).toBe(
      "eigenvalues finally clicked",
    );
    expect(recap({ note: "   " }).note).toBeNull();
    expect(recap({ note: null }).note).toBeNull();
    expect(recap({ note: "x".repeat(500) }).note).toHaveLength(MAX_RECAP_NOTE_LENGTH);
  });

  it("treats a backwards clock as zero minutes rather than a negative recap", () => {
    const result = recap({ endedAtMs: T0 - 60_000 });
    expect(result.actualMinutes).toBe(0);
    expect(result.completionPercent).toBe(0);
  });
});

describe("localDayIn", () => {
  /**
   * CLAUDE.md: storage is UTC, the calendar day is the user's. The same instant
   * is a different day depending on whose profile you ask.
   */
  it("resolves the calendar day in the profile timezone", () => {
    const instant = Date.parse("2026-09-27T23:30:00.000Z");

    expect(localDayIn("UTC", instant)).toBe("2026-09-27");
    expect(localDayIn("Europe/Lisbon", instant)).toBe("2026-09-28"); // UTC+1 in September
    expect(localDayIn("Pacific/Auckland", instant)).toBe("2026-09-28");
    expect(localDayIn("America/Los_Angeles", instant)).toBe("2026-09-27");
  });

  it("crosses midnight backwards too", () => {
    const instant = Date.parse("2026-09-27T00:30:00.000Z");
    expect(localDayIn("America/Los_Angeles", instant)).toBe("2026-09-26");
  });
});
