import { describe, it, expect } from "vitest";
import { computePriority } from "./priority";

describe("computePriority (item 32)", () => {
  it("30% midterm in 5 days outranks 2% quiz due tomorrow", () => {
    const midterm = computePriority({
      gradeShare: 30,
      daysUntilDue: 5,
      minutesRemaining: 300,
      status: "not_started",
    });
    const quiz = computePriority({
      gradeShare: 2,
      daysUntilDue: 1,
      minutesRemaining: 30,
      status: "not_started",
    });
    expect(midterm.score).toBeGreaterThan(quiz.score);
  });

  it("overdue items rise to the top", () => {
    const overdue = computePriority({
      gradeShare: 10,
      daysUntilDue: -2,
      minutesRemaining: 60,
      status: "not_started",
    });
    const future = computePriority({
      gradeShare: 10,
      daysUntilDue: 7,
      minutesRemaining: 60,
      status: "not_started",
    });
    expect(overdue.score).toBeGreaterThan(future.score);
  });

  it("graded/submitted items sink to the bottom", () => {
    const graded = computePriority({
      gradeShare: 30,
      daysUntilDue: 0,
      minutesRemaining: 0,
      status: "graded",
    });
    const active = computePriority({
      gradeShare: 5,
      daysUntilDue: 3,
      minutesRemaining: 60,
      status: "not_started",
    });
    expect(graded.score).toBeLessThan(active.score);
  });
});
