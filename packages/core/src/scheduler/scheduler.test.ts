import { describe, it, expect } from "vitest";
import { scheduleStudyBlocks, planNightly, generateReviewPlan } from "./index";

const task = (id: string, dueDay: string, gradeShare: number, minutes = 90) => ({
  assignmentId: id,
  courseId: "c1",
  title: id,
  dueAt: `${dueDay}T23:59:00`,
  gradeShare,
  status: "not_started" as const,
  minutesRemaining: minutes,
});

describe("scheduleStudyBlocks (item 34)", () => {
  it("never schedules past a due date", () => {
    const out = scheduleStudyBlocks({
      tasks: [task("t1", "2026-02-10", 30)],
      availability: {
        "2026-02-08": 120,
        "2026-02-09": 120,
        "2026-02-10": 120, // due day itself — must not be used
      },
      timezone: "UTC",
      now: "2026-02-08T09:00:00Z",
      startDay: "2026-02-08",
    });
    expect(out.blocks.every((b) => b.startAt.slice(0, 10) < "2026-02-10")).toBe(true);
    expect(out.blocks.length).toBeGreaterThan(0);
  });

  it("spreads exam prep across multiple days", () => {
    const out = scheduleStudyBlocks({
      tasks: [task("exam", "2026-02-15", 30, 180)],
      availability: {
        "2026-02-10": 120,
        "2026-02-11": 120,
        "2026-02-12": 120,
        "2026-02-13": 120,
        "2026-02-14": 120,
      },
      timezone: "UTC",
      now: "2026-02-10T09:00:00Z",
      startDay: "2026-02-10",
    });
    const days = new Set(out.blocks.map((b) => b.startAt.slice(0, 10)));
    expect(days.size).toBeGreaterThanOrEqual(2);
  });

  it("flags overloaded days and unschedulable tasks", () => {
    const out = scheduleStudyBlocks({
      tasks: [task("t1", "2026-02-09", 40, 300)],
      availability: { "2026-02-08": 60 },
      timezone: "UTC",
      now: "2026-02-08T09:00:00Z",
      startDay: "2026-02-08",
    });
    expect(out.overloadedDays).toContain("2026-02-08");
    expect(out.unscheduled.length).toBeGreaterThan(0);
  });
});

describe("planNightly (item 35)", () => {
  it("marks past planned blocks as missed and reschedules remaining work", () => {
    const report = planNightly(
      "2026-02-09T00:00:00Z",
      [
        {
          id: "b1",
          startAt: "2026-02-08T16:00:00",
          endAt: "2026-02-08T17:00:00",
          status: "planned",
          assignmentId: "t1",
        },
      ],
      [task("t1", "2026-02-12", 25, 90)],
      { "2026-02-09": 120, "2026-02-10": 120, "2026-02-11": 120 },
      "2026-02-09",
    );
    expect(report.missedBlockIds).toEqual(["b1"]);
    expect(report.rescheduled.length).toBeGreaterThan(0);
  });
});

describe("generateReviewPlan (item 36)", () => {
  it("creates sessions 7, 3, and 1 days before the exam", () => {
    const blocks = generateReviewPlan(
      [{ assignmentId: "e1", courseId: "c1", title: "Midterm", dueAt: "2026-03-15T09:00:00" }],
      "2026-03-01T00:00:00Z",
    );
    const days = blocks.map((b) => b.startAt.slice(0, 10)).sort();
    expect(days).toEqual(["2026-03-08", "2026-03-12", "2026-03-14"]);
  });

  it("skips sessions that would land in the past", () => {
    const blocks = generateReviewPlan(
      [{ assignmentId: "e1", courseId: "c1", title: "Midterm", dueAt: "2026-03-03T09:00:00" }],
      "2026-03-01T00:00:00Z",
    );
    const days = blocks.map((b) => b.startAt.slice(0, 10)).sort();
    expect(days).toEqual(["2026-03-02"]); // only T-1 remains
  });
});
