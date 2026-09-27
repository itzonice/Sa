import { describe, it, expect } from "vitest";
import { currentGrade, gradeNeeded, whatIf, letterFor } from "./index";
import type { Assignment, GradeCategory } from "@studyly/db";

function cat(id: string, name: string, weight: number, drop = 0): GradeCategory {
  return {
    id,
    course_id: "c1",
    name,
    weight,
    drop_lowest_n: drop,
    created_at: "2026-01-01T00:00:00Z",
  };
}

function asg(
  id: string,
  category_id: string | null,
  score: number | null,
  status: Assignment["status"],
  max_score = 100,
): Assignment {
  return {
    id,
    course_id: "c1",
    category_id,
    title: id,
    due_at: "2026-01-01T00:00:00Z",
    status,
    score,
    max_score,
    weight_share: null,
    priority_boost: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

describe("currentGrade (item 28)", () => {
  it("renormalizes weights when a category has no scores yet", () => {
    const cats = [cat("exams", "Exams", 60), cat("hw", "Homework", 40)];
    const asgs = [asg("e1", "exams", 80, "graded"), asg("h1", "hw", null, "not_started")];
    const r = currentGrade(cats, asgs);
    // Only Exams has grades; its 80% should be the whole grade.
    expect(r.grade).toBeCloseTo(80, 1);
    expect(r.renormalized).toBe(true);
  });

  it("handles extra credit above 100%", () => {
    const cats = [cat("q", "Quizzes", 100)];
    const asgs = [asg("q1", "q", 100, "graded"), asg("q2", "q", 105, "graded")];
    const r = currentGrade(cats, asgs);
    expect((r.grade ?? 0) > 100).toBe(true);
  });

  it("respects drop_lowest_n", () => {
    const cats = [cat("q", "Quizzes", 100, 1)];
    const asgs = [asg("q1", "q", 0, "graded"), asg("q2", "q", 100, "graded")];
    const r = currentGrade(cats, asgs);
    expect(r.grade).toBeCloseTo(100, 1);
  });

  it("returns null grade when nothing is graded", () => {
    const cats = [cat("e", "Exams", 100)];
    const r = currentGrade(cats, [asg("e1", "e", null, "not_started")]);
    expect(r.grade).toBeNull();
  });

  it("uses a custom letter scale when provided", () => {
    expect(letterFor(94)).toBe("A");
    expect(
      letterFor(94, [
        { min: 95, letter: "A" },
        { min: 0, letter: "B" },
      ]),
    ).toBe("B");
  });
});

describe("gradeNeeded (item 29)", () => {
  it("computes required ratio on remaining work", () => {
    const cats = [cat("e", "Exams", 50), cat("f", "Final", 50)];
    const asgs = [asg("e1", "e", 80, "graded")];
    // earned = 40 points of 100; target 90 => need 50 from final => 100% on final
    const r = gradeNeeded(cats, asgs, 90);
    expect(r.kind).toBe("needed");
    if (r.kind === "needed") {
      expect(r.requiredRatio).toBeCloseTo(1.0, 2);
    }
  });

  it("detects impossible targets", () => {
    const cats = [cat("e", "Exams", 50), cat("f", "Final", 50)];
    const asgs = [asg("e1", "e", 40, "graded")];
    // earned = 20; max final = 100+20... wait earned 20 + remaining 50 -> best 70 < 90 target
    const r = gradeNeeded(cats, asgs, 90);
    expect(r.kind).toBe("impossible");
    if (r.kind === "impossible") {
      expect(r.bestAchievable).toBeCloseTo(70, 1);
    }
  });

  it("detects already-secured targets", () => {
    const cats = [cat("e", "Exams", 50), cat("f", "Final", 50)];
    const asgs = [asg("e1", "e", 100, "graded")];
    // earned 50; even 0 on final => 50... target 45 secured
    const r = gradeNeeded(cats, asgs, 45);
    expect(r.kind).toBe("secured");
  });
});

describe("whatIf (item 30)", () => {
  it("projects grade from hypothetical scores", () => {
    const cats = [cat("e", "Exams", 100)];
    const asgs = [asg("e1", "e", null, "not_started")];
    const r = whatIf(cats, asgs, { e1: 0.9 });
    expect(r.grade).toBeCloseTo(90, 1);
  });
});
