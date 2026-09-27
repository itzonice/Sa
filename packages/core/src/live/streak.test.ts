import { describe, expect, it } from "vitest";
import {
  applyCompletion,
  computeStreak,
  daysBetween,
  describeStreak,
  EMPTY_STREAK,
  GRACE_DAYS,
  type StreakOutcome,
  type StreakState,
} from "./streak";

/**
 * The cases below are the contract. `public.recompute_streak` in migration 0010
 * implements the same table in SQL, and supabase/tests/live_session_tests.sql
 * asserts the same rows, so a change to one has to be a change to all three.
 */
const CASES: {
  name: string;
  before: StreakState;
  completedDay: string;
  want: { current: number; outcome: StreakOutcome };
}[] = [
  {
    name: "first ever completion starts a streak",
    before: EMPTY_STREAK,
    completedDay: "2026-09-27",
    want: { current: 1, outcome: "started" },
  },
  {
    name: "the next day extends it",
    before: { current: 1, longest: 1, lastDay: "2026-09-26" },
    completedDay: "2026-09-27",
    want: { current: 2, outcome: "extended" },
  },
  {
    name: "a second completion the same day is a no-op",
    before: { current: 4, longest: 9, lastDay: "2026-09-27" },
    completedDay: "2026-09-27",
    want: { current: 4, outcome: "unchanged" },
  },
  {
    name: "one missed day is forgiven and does not extend",
    before: { current: 3, longest: 3, lastDay: "2026-09-25" },
    completedDay: "2026-09-27",
    want: { current: 3, outcome: "held" },
  },
  {
    name: "two missed days break the run",
    before: { current: 3, longest: 3, lastDay: "2026-09-24" },
    completedDay: "2026-09-27",
    want: { current: 1, outcome: "reset" },
  },
  {
    name: "a month away restarts from one",
    before: { current: 12, longest: 12, lastDay: "2026-08-01" },
    completedDay: "2026-09-27",
    want: { current: 1, outcome: "reset" },
  },
];

describe("applyCompletion", () => {
  it.each(CASES)("$name", ({ before, completedDay, want }) => {
    const got = applyCompletion(before, completedDay);
    expect(got.current).toBe(want.current);
    expect(got.outcome).toBe(want.outcome);
    expect(got.lastDay).toBe(completedDay);
  });

  it("never lets longest fall below current", () => {
    const got = applyCompletion({ current: 5, longest: 2, lastDay: "2026-09-26" }, "2026-09-27");
    expect(got.longest).toBe(6);
  });

  it("preserves a longer historical best across a reset", () => {
    const got = applyCompletion({ current: 1, longest: 30, lastDay: "2026-01-01" }, "2026-09-27");
    expect(got).toMatchObject({ current: 1, longest: 30, outcome: "reset" });
  });

  it("holds on exactly the grace boundary, not one day past it", () => {
    const onBoundary = applyCompletion(
      { current: 2, longest: 2, lastDay: "2026-09-25" },
      "2026-09-27",
    );
    const pastBoundary = applyCompletion(
      { current: 2, longest: 2, lastDay: "2026-09-24" },
      "2026-09-27",
    );
    expect(onBoundary.outcome).toBe("held");
    expect(pastBoundary.outcome).toBe("reset");
  });

  it("uses a grace of exactly one day", () => {
    expect(GRACE_DAYS).toBe(1);
  });
});

describe("daysBetween", () => {
  it("counts forwards, backwards and across a month boundary", () => {
    expect(daysBetween("2026-09-26", "2026-09-27")).toBe(1);
    expect(daysBetween("2026-09-27", "2026-09-26")).toBe(-1);
    expect(daysBetween("2026-02-28", "2026-03-01")).toBe(1);
    expect(daysBetween("2024-02-28", "2024-03-01")).toBe(2); // leap year
  });

  it("rejects anything that is not a calendar day", () => {
    expect(() => daysBetween("27/09/2026", "2026-09-28")).toThrow(TypeError);
  });
});

describe("computeStreak", () => {
  it("is order-independent and agrees with sequential application", () => {
    const days = ["2026-09-24", "2026-09-27", "2026-09-25", "2026-09-26"];

    const folded = computeStreak(days, "2026-09-27");

    const sequential = [...days].sort().reduce((state, day) => {
      const next = applyCompletion(state, day);
      return { current: next.current, longest: next.longest, lastDay: next.lastDay };
    }, EMPTY_STREAK);

    expect(folded).toEqual(sequential);
    expect(folded.current).toBe(4);
  });

  it("a grace day keeps the run alive without inflating it", () => {
    // 25th and 27th, the 26th missed. The streak survives (current is not 0 and
    // lastDay is not null) but the 27th does not extend a 1-day run into a 2-day
    // one: you did not study two days in a row.
    const state = computeStreak(["2026-09-25", "2026-09-27"], "2026-09-27");
    expect(state.current).toBe(1);
    expect(state.lastDay).toBe("2026-09-27");
  });

  it("the grace day is still available on the following day", () => {
    // One day after the last completion: still inside the window, run intact.
    const alive = computeStreak(["2026-09-25", "2026-09-27"], "2026-09-28");
    expect(alive).toMatchObject({ current: 1, lastDay: "2026-09-27" });
  });

  it("one missed day is the whole of the grace", () => {
    // Last completed 27th. On the 28th one day has been missed: still alive.
    const oneMissed = computeStreak(["2026-09-25", "2026-09-27"], "2026-09-29");
    expect(oneMissed).toMatchObject({ current: 1, lastDay: "2026-09-27" });
  });

  it("two missed days ends the run", () => {
    // On the 30th, both the 28th and the 29th were missed: over.
    const state = computeStreak(["2026-09-25", "2026-09-27"], "2026-09-30");
    expect(state).toMatchObject({ current: 0, lastDay: null, longest: 1 });
  });

  it("reports an expired run as broken but remembers the best", () => {
    const state = computeStreak(["2026-08-01", "2026-08-02", "2026-08-03"], "2026-09-27");
    expect(state.current).toBe(0);
    expect(state.lastDay).toBeNull();
    expect(state.longest).toBe(3);
  });

  it("ignores duplicates", () => {
    const state = computeStreak(["2026-09-26", "2026-09-26", "2026-09-27"], "2026-09-27");
    expect(state.current).toBe(2);
  });

  it("returns empty for no history", () => {
    expect(computeStreak([], "2026-09-27")).toEqual(EMPTY_STREAK);
  });
});

describe("describeStreak", () => {
  it("warns on a grace day", () => {
    const copy = describeStreak({ current: 3, longest: 3, lastDay: "2026-09-25" }, "2026-09-27");
    expect(copy.tone).toBe("warning");
    expect(copy.headline).toBe("3 days in a row");
  });

  it("is critical once the run is unrecoverable", () => {
    const copy = describeStreak({ current: 3, longest: 8, lastDay: "2026-09-01" }, "2026-09-27");
    expect(copy.tone).toBe("critical");
    expect(copy.detail).toContain("8 days");
  });

  it("is positive on the day itself", () => {
    const copy = describeStreak({ current: 1, longest: 1, lastDay: "2026-09-27" }, "2026-09-27");
    expect(copy).toMatchObject({ tone: "positive", headline: "1 day in a row" });
  });
});
