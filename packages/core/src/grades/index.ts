/**
 * Items 28, 29, 30, 31: grade math.
 * All functions are pure and operate on typed rows from the db package.
 */

import type { Assignment, GradeCategory } from "@studyly/db";

export type WithScore = Pick<Assignment, "score" | "max_score">;

export type CategoryGrade = {
  categoryId: string;
  name: string;
  weight: number;
  /** Mean of scores in this category (0-1). */
  score: number | null;
  /** Weight actually counted toward the final grade after renormalization. */
  effectiveWeight: number;
  gradedCount: number;
  totalCount: number;
};

export type CurrentGrade = {
  /** 0-100, null when nothing is graded at all. */
  grade: number | null;
  letter: string | null;
  categories: CategoryGrade[];
  renormalized: boolean;
};

const defaultScale: { min: number; letter: string }[] = [
  { min: 93, letter: "A" },
  { min: 90, letter: "A-" },
  { min: 87, letter: "B+" },
  { min: 83, letter: "B" },
  { min: 80, letter: "B-" },
  { min: 77, letter: "C+" },
  { min: 73, letter: "C" },
  { min: 70, letter: "C-" },
  { min: 67, letter: "D+" },
  { min: 63, letter: "D" },
  { min: 60, letter: "D-" },
  { min: 0, letter: "F" },
];

export function letterFor(pct: number, scale?: { min: number; letter: string }[] | null): string {
  const s = scale ?? defaultScale;
  const sorted = [...s].sort((a, b) => b.min - a.min);
  for (const band of sorted) {
    if (pct >= band.min) return band.letter;
  }
  return "F";
}

function categoryMean(
  assignments: Assignment[],
  dropLowestN: number,
): { mean: number | null; gradedCount: number } {
  const graded = assignments
    .filter((a) => a.status === "graded" && a.score !== null)
    .sort((a, b) => (a.score ?? 0) / a.max_score - (b.score ?? 0) / b.max_score);
  if (graded.length === 0) return { mean: null, gradedCount: 0 };
  const droppable = Math.min(dropLowestN, graded.length - 1); // keep at least one
  const kept = graded.slice(droppable);
  const total = kept.reduce((s, a) => s + (a.score ?? 0) / a.max_score, 0);
  return { mean: total / kept.length, gradedCount: graded.length };
}

/**
 * Item 28: current grade with weight renormalization.
 * Categories with no graded work yet contribute 0 weight; the remaining
 * weights are renormalized to 100 so the number reflects "so far".
 */
export function currentGrade(
  categories: GradeCategory[],
  assignments: Assignment[],
  opts?: { scale?: { min: number; letter: string }[] | null },
): CurrentGrade {
  const perCat: CategoryGrade[] = categories.map((c) => {
    const inCat = assignments.filter((a) => a.category_id === c.id);
    const { mean, gradedCount } = categoryMean(inCat, c.drop_lowest_n);
    return {
      categoryId: c.id,
      name: c.name,
      weight: Number(c.weight),
      score: mean === null ? null : mean * 100,
      effectiveWeight: mean === null ? 0 : Number(c.weight),
      gradedCount,
      totalCount: inCat.length,
    };
  });

  const weightSum = perCat.reduce((s, c) => s + c.effectiveWeight, 0);
  const renormalized = weightSum > 0 && weightSum < 99.999;

  let earned = 0;
  for (const c of perCat) {
    if (c.score !== null && weightSum > 0) {
      earned += (c.score / 100) * (c.effectiveWeight / weightSum) * 100;
    }
  }

  const grade = weightSum === 0 ? null : earned;
  return {
    grade,
    letter: grade === null ? null : letterFor(grade, opts?.scale),
    categories: perCat,
    renormalized,
  };
}

/**
 * Item 29: score needed on remaining work to reach a target grade.
 * Returns { possible: false } when even 100% on everything left can't reach
 * the target, and { secured: true } when the target is already locked in
 * (even 0% on remaining work keeps the target reachable).
 */
export type GradeNeededResult =
  | { kind: "needed"; requiredRatio: number; remainingWeight: number }
  | { kind: "impossible"; bestAchievable: number }
  | { kind: "secured"; worstAchievable: number };

export function gradeNeeded(
  categories: GradeCategory[],
  assignments: Assignment[],
  target: number,
): GradeNeededResult {
  const cur = currentGrade(categories, assignments);
  // Reconstruct graded weight vs remaining weight per category.
  let gradedWeight = 0;
  let earnedPoints = 0; // in "percent of course" units

  for (const c of cur.categories) {
    if (c.gradedCount === 0) continue;
    const inCat = assignments.filter((a) => a.category_id === c.categoryId);
    const graded = inCat.filter((a) => a.status === "graded" && a.score !== null);
    const catMean = graded.reduce((s, a) => s + (a.score ?? 0) / a.max_score, 0) / graded.length;
    const w = Number(c.weight);
    gradedWeight += w;
    earnedPoints += catMean * w;
  }

  const remainingWeight = 100 - gradedWeight;

  // Final = earnedPoints + ratio * remainingWeight; solve for the target ratio.
  if (remainingWeight <= 0) {
    const finalPct = earnedPoints;
    if (finalPct >= target) return { kind: "secured", worstAchievable: finalPct };
    return { kind: "impossible", bestAchievable: finalPct };
  }

  const needed = target - earnedPoints;
  if (needed <= 0) {
    return { kind: "secured", worstAchievable: earnedPoints };
  }
  const requiredRatio = needed / remainingWeight;
  if (requiredRatio > 1) {
    const bestAchievable = earnedPoints + remainingWeight;
    return { kind: "impossible", bestAchievable };
  }
  return { kind: "needed", requiredRatio, remainingWeight };
}

/**
 * Item 30: what-if — projected grade from hypothetical scores.
 * `hypotheticals` maps assignment id -> assumed ratio (0-1+).
 */
export function whatIf(
  categories: GradeCategory[],
  assignments: Assignment[],
  hypotheticals: Record<string, number>,
  opts?: { scale?: { min: number; letter: string }[] | null },
): CurrentGrade {
  const adjusted = assignments.map((a) => {
    const h = hypotheticals[a.id];
    if (h === undefined) return a;
    return {
      ...a,
      status: "graded" as const,
      score: h * a.max_score,
    };
  });
  return currentGrade(categories, adjusted, opts);
}
