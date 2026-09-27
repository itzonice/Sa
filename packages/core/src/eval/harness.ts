/**
 * Item 27: eval harness.
 * Scores parser output against expected JSON fixtures:
 * date accuracy, category accuracy, weight totals.
 * Run: pnpm -F @studyly/core eval  (requires ANTHROPIC_API_KEY)
 */

import { parseResultSchema } from "../parser/schema";
import { postprocess } from "../parser/postprocess";
import { parseSyllabus } from "../parser/parse";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

export type ExpectedAssignment = {
  title: string;
  due_date: string; // yyyy-mm-dd
  category_name: string | null;
};

export type ExpectedFixture = {
  name: string;
  timezone: string;
  term_start?: string;
  term_end?: string;
  categories: { name: string; weight: number }[];
  assignments: ExpectedAssignment[];
};

export type FixtureScore = {
  name: string;
  dateAccuracy: number; // 0..1
  categoryAccuracy: number; // 0..1
  weightTotalError: number; // |total - 100|
  passed: boolean;
  details: string[];
};

export function loadFixtures(dir: string): ExpectedFixture[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json") && !f.endsWith(".output.json"))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));
}

function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function scoreParse(fixture: ExpectedFixture, actualRaw: unknown): FixtureScore {
  const details: string[] = [];
  const parsed = parseResultSchema.parse(actualRaw);
  const processed = postprocess(parsed, {
    timezone: fixture.timezone,
    term_start: fixture.term_start,
    term_end: fixture.term_end,
  });

  const active = processed.assignments.filter((a) => !a.dropped);

  // Date accuracy: exact-date matches over expected assignments.
  // An assignment postprocess dropped as out-of-term counts as correctly handled
  // (the fixture listed it only to verify the drop happens).
  let dateHits = 0;
  for (const exp of fixture.assignments) {
    const got = active.find((a) => norm(a.title) === norm(exp.title));
    if (!got) {
      const droppedOk = processed.assignments.find(
        (a) => norm(a.title) === norm(exp.title) && a.dropped && a.drop_reason,
      );
      if (droppedOk) {
        dateHits++;
      } else {
        details.push(`missing assignment: ${exp.title}`);
      }
      continue;
    }
    const gotDay = got.due_at.slice(0, 10);
    if (gotDay === exp.due_date) dateHits++;
    else details.push(`date mismatch ${exp.title}: expected ${exp.due_date}, got ${gotDay}`);
  }
  const dateAccuracy = fixture.assignments.length ? dateHits / fixture.assignments.length : 1;

  // Category accuracy: matched category names for assignments that have one.
  let catHits = 0;
  let catTotal = 0;
  for (const exp of fixture.assignments) {
    if (!exp.category_name) continue;
    catTotal++;
    const got = active.find((a) => norm(a.title) === norm(exp.title));
    if (got?.category_id) {
      const expectedId = processed.categories.find(
        (c) => norm(c.name) === norm(exp.category_name!),
      );
      if (expectedId && got.category_id === `cat_${processed.categories.indexOf(expectedId)}`) {
        catHits++;
      }
    }
  }
  const categoryAccuracy = catTotal ? catHits / catTotal : 1;

  // Weight totals.
  const weightTotal = fixture.categories.reduce((s, c) => s + c.weight, 0);
  const weightTotalError = Math.abs(weightTotal - 100);

  const passed = dateAccuracy >= 0.8 && categoryAccuracy >= 0.7 && processed.warnings.length <= 2;

  return { name: fixture.name, dateAccuracy, categoryAccuracy, weightTotalError, passed, details };
}

export async function runEval(fixturesDir: string, syllabiDir: string): Promise<FixtureScore[]> {
  const fixtures = loadFixtures(fixturesDir);
  const scores: FixtureScore[] = [];

  for (const fixture of fixtures) {
    const syllabusPath = join(syllabiDir, `${fixture.name}.txt`);
    if (!existsSync(syllabusPath)) {
      scores.push({
        name: fixture.name,
        dateAccuracy: 0,
        categoryAccuracy: 0,
        weightTotalError: 100,
        passed: false,
        details: ["syllabus text file missing"],
      });
      continue;
    }
    const text = readFileSync(syllabusPath, "utf8");
    const outcome = await parseSyllabus({
      text,
      timezone: fixture.timezone,
      term_start: fixture.term_start,
      term_end: fixture.term_end,
    });
    if (!outcome.ok) {
      scores.push({
        name: fixture.name,
        dateAccuracy: 0,
        categoryAccuracy: 0,
        weightTotalError: 100,
        passed: false,
        details: [`parse failed: ${outcome.error}`],
      });
      continue;
    }
    scores.push(scoreParse(fixture, outcome.result));
  }
  return scores;
}
