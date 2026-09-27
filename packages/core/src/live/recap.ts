/**
 * Item 18: the post-session recap.
 *
 * Private by construction. The payload is returned to the user who finished the
 * session and stored on their own session row (`recap_note`); buddies see their
 * own copy and nothing of anyone else's note.
 */
import { MAX_PLANNED_MINUTES } from "./countdown";
import { applyCompletion, describeStreak, type StreakState } from "./streak";

export const MAX_RECAP_NOTE_LENGTH = 280;

export type RecapInput = {
  plannedMinutes: number;
  startedAtMs: number;
  endedAtMs: number;
  streakBefore: StreakState;
  /** Calendar day the session ended, in the user's own timezone. */
  localDay: string;
  note?: string | null;
};

export type Recap = {
  plannedMinutes: number;
  actualMinutes: number;
  /** Share of the planned block completed, as a whole percentage. */
  completionPercent: number;
  /** Stopped short of the plan. */
  endedEarly: boolean;
  streakBefore: StreakState;
  streakAfter: ReturnType<typeof applyCompletion>;
  streakCopy: ReturnType<typeof describeStreak>;
  note: string | null;
};

export function buildRecap(input: RecapInput): Recap {
  const elapsedMs = Math.max(0, input.endedAtMs - input.startedAtMs);
  const actualMinutes = Math.min(
    MAX_PLANNED_MINUTES * 3,
    Math.max(0, Math.floor(elapsedMs / 60_000)),
  );
  const plannedMinutes = input.plannedMinutes;
  const completionPercent = Math.min(
    100,
    Math.round((actualMinutes / Math.max(1, plannedMinutes)) * 100),
  );

  const streakAfter = applyCompletion(input.streakBefore, input.localDay);
  const trimmed = (input.note ?? "").trim();

  return {
    plannedMinutes,
    actualMinutes,
    completionPercent,
    endedEarly: actualMinutes < plannedMinutes,
    streakBefore: input.streakBefore,
    streakAfter,
    streakCopy: describeStreak(streakAfter, input.localDay),
    note: trimmed.length > 0 ? trimmed.slice(0, MAX_RECAP_NOTE_LENGTH) : null,
  };
}

/** The local calendar day, in a named IANA zone, as `YYYY-MM-DD`. */
export function localDayIn(timezone: string, instantMs: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(instantMs));
}
