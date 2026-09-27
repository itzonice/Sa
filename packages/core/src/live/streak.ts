/**
 * Item 16: streak rules.
 *
 * A streak is the number of consecutive calendar days, in the user's own
 * timezone, on which at least one session reached `done`. One missed day is a
 * grace day: it neither extends the streak nor breaks it. Two in a row resets it.
 *
 * This is the reference implementation. `public.recompute_streak` in 0010 mirrors
 * it in SQL so the write path never has to round-trip through the client, and the
 * two are held together by the shared table of cases in `streak.test.ts` plus
 * `supabase/tests/live_session_tests.sql`.
 */

export const GRACE_DAYS = 1;

export type StreakState = {
  /** Days in the current run; 0 when broken. */
  current: number;
  /** Best run ever. Never decreases. */
  longest: number;
  /** Local calendar day (`YYYY-MM-DD`) of the last completed session. */
  lastDay: string | null;
};

export type StreakOutcome = "unchanged" | "extended" | "held" | "started" | "reset";

export type StreakResult = StreakState & { outcome: StreakOutcome };

export const EMPTY_STREAK: StreakState = { current: 0, longest: 0, lastDay: null };

/** Whole days from `from` to `to`; negative when `to` precedes `from`. */
export function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) {
    throw new TypeError(`not a calendar day: ${from} -> ${to}`);
  }
  return Math.round((b - a) / 86_400_000);
}

/**
 * Applies one completion to a streak.
 *
 * Completing on a day already counted is a no-op, which is what makes the
 * `end_live_session` RPC safe to call twice.
 */
export function applyCompletion(state: StreakState, completedDay: string): StreakResult {
  if (state.lastDay === completedDay) {
    return { ...state, outcome: "unchanged" };
  }

  const gap = state.lastDay === null ? null : daysBetween(state.lastDay, completedDay);

  let current: number;
  let outcome: StreakOutcome;

  if (gap === null) {
    current = 1;
    outcome = "started";
  } else if (gap === 1) {
    current = state.current + 1;
    outcome = "extended";
  } else if (gap <= 1 + GRACE_DAYS) {
    // Inside the grace window: the run is preserved exactly as it was.
    current = state.current;
    outcome = "held";
  } else {
    current = 1;
    outcome = "reset";
  }

  return { current, longest: Math.max(state.longest, current), lastDay: completedDay, outcome };
}

/**
 * Folds a set of completed days into a streak from scratch, independent of the
 * order they were applied. Used by the nightly backfill and by tests that want
 * an assertion that does not depend on insertion order.
 *
 * Note the two different notions of "consecutive" in play, which is exactly the
 * subtlety in item 16:
 *   - a *run* is a dense 1-day-apart sequence, and its length is the streak
 *     counter;
 *   - the run *survives* one missed day, so a gap of 2 does not kill it, it just
 *     does not add to it.
 * So completing on the 25th and 27th is a 1-day streak that is still alive on the
 * 27th, not a 2-day streak.
 */
export function computeStreak(completedDays: readonly string[], today: string): StreakState {
  const ordered = [...new Set(completedDays)].sort();

  // Longest run ever: scan the whole history for the densest stretch.
  let longest = 0;
  let runStart = 0;
  for (let i = 1; i <= ordered.length; i += 1) {
    const prev = ordered[i - 1] as string;
    const cur = i < ordered.length ? (ordered[i] as string) : null;
    if (cur === null || daysBetween(prev, cur) !== 1) {
      longest = Math.max(longest, i - runStart);
      runStart = i;
    }
  }

  const lastDay = ordered.findLast((day) => day <= today) ?? null;
  if (lastDay === null) return { current: 0, longest, lastDay: null };

  // Too long since the last completion: the run is over.
  if (daysBetween(lastDay, today) > 1 + GRACE_DAYS) {
    return { current: 0, longest, lastDay: null };
  }

  // Walk back over the dense run that ends on the last completed day.
  const lastIndex = ordered.lastIndexOf(lastDay);
  let current = 0;
  for (let i = lastIndex; i >= 0; i -= 1) {
    const day = ordered[i] as string;
    if (i < lastIndex && daysBetween(day, ordered[i + 1] as string) !== 1) break;
    current += 1;
  }

  return { current, longest: Math.max(longest, current), lastDay };
}

export type StreakCopy = {
  headline: string;
  detail: string | null;
  tone: "neutral" | "positive" | "warning" | "critical";
};

/** Recap copy. Lives next to the maths so the wording cannot drift from it. */
export function describeStreak(state: StreakState, today: string): StreakCopy {
  if (state.current === 0 || state.lastDay === null) {
    return {
      headline: "No streak yet",
      detail: "Finish one session to start one.",
      tone: "neutral",
    };
  }

  const gap = daysBetween(state.lastDay, today);
  const label = `${state.current} day${state.current === 1 ? "" : "s"} in a row`;

  if (gap === 0) return { headline: label, detail: "Today already counts.", tone: "positive" };
  if (gap === 1)
    return { headline: label, detail: "One session today keeps it going.", tone: "positive" };
  if (gap <= 1 + GRACE_DAYS) {
    return {
      headline: label,
      detail: "Grace day: one session today still saves the streak.",
      tone: "warning",
    };
  }
  return {
    headline: "Streak broken",
    detail: `Your best run is ${state.longest} day${state.longest === 1 ? "" : "s"}.`,
    tone: "critical",
  };
}
