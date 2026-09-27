/**
 * Item 32: priority score from grade share, days until due, minutes remaining,
 * and status. The canonical test: a 30% midterm in 5 days outranks a 2% quiz
 * due tomorrow.
 */

export type PriorityInput = {
  /** Percent of the final grade this item controls (category weight or weight share). */
  gradeShare: number;
  /** Days until due (can be fractional; negative = overdue). */
  daysUntilDue: number;
  /** Estimated minutes of work remaining. */
  minutesRemaining: number;
  /** Assignment status. */
  status: "not_started" | "in_progress" | "submitted" | "graded";
  /** Optional boost (user-pinned, exam mode). */
  boost?: number | undefined;
};

export type PriorityResult = {
  score: number;
  urgency: number; // 0..1 — climbs as the deadline approaches
  importance: number; // 0..1 — from grade share
};

const URGENCY_MIDPOINT_DAYS = 3; // urgency crosses 0.5 at 3 days out

export function computePriority(input: PriorityInput): PriorityResult {
  const d = Math.max(input.daysUntilDue, 0);
  // Sigmoid urgency: ~0.88 at 1 day, ~0.5 at 3 days, ~0.12 at 5 days, →0 as d grows.
  const urgency = 1 / (1 + Math.exp((d - URGENCY_MIDPOINT_DAYS) * 1.2));

  const importance = 1 - Math.exp(-input.gradeShare / 12);

  const statusFactor =
    input.status === "not_started" ? 1 : input.status === "in_progress" ? 0.9 : 0.1;

  // Larger remaining effort nudges priority up (start big things early), saturating at 1.
  const effortPressure = input.minutesRemaining / (input.minutesRemaining + 120);

  const score =
    (0.55 * urgency + 0.45 * importance) * statusFactor * effortPressure * 100 + (input.boost ?? 0);

  return { score, urgency, importance };
}

/** Compare helper for feeds: higher score first. */
export function byPriorityDesc(a: { score: number }, b: { score: number }): number {
  return b.score - a.score;
}
