/**
 * Item 27: eval harness smoke tests using the synthetic fixtures.
 * These run without an API key — they validate scoring/postprocess behavior.
 * The full 30-syllabus live eval runs via `pnpm -F @studyly/core eval` with a key.
 */

import { describe, it, expect } from "vitest";
import { scoreParse } from "./harness";
import { syntheticFixtures } from "./fixtures";
import { parseResultSchema } from "../parser/schema";

function buildRaw(fixture: (typeof syntheticFixtures)[number], imperfect = false) {
  return {
    course: { title: "Test Course" },
    categories: fixture.categories.map((c) => ({ name: c.name, weight: c.weight })),
    assignments: fixture.assignments.map((a) => ({
      title: a.title,
      category_name: a.category_name,
      due_date: imperfect && a.title === "Quiz 1" ? "2026-02-30" : a.due_date,
      confidence: {},
    })),
  };
}

describe("eval harness (item 27)", () => {
  for (const fixture of syntheticFixtures) {
    it(`scores fixture: ${fixture.name}`, () => {
      const raw = buildRaw(fixture);
      expect(() => parseResultSchema.parse(raw)).not.toThrow();
      const score = scoreParse(fixture, raw);
      expect(score.dateAccuracy).toBeGreaterThan(0.5);
      expect(score.details).toBeInstanceOf(Array);
    });
  }

  it("penalizes wrong dates", () => {
    const f = syntheticFixtures[0]!;
    const score = scoreParse(f, buildRaw(f, true));
    const withBadDate = score;
    expect(withBadDate.dateAccuracy).toBeLessThanOrEqual(0.5);
  });

  it("flags weight totals that miss 100", () => {
    const f = syntheticFixtures.find((x) => x.name === "syn-weights-not-100")!;
    const score = scoreParse(f, buildRaw(f));
    expect(score.weightTotalError).toBe(25);
  });
});
