import { describe, it, expect } from "vitest";
import { postprocess } from "./postprocess";
import { chunkSyllabus, mergeParseResults } from "./chunk";
import { assertSafeUrl, stripHtml } from "./extract";
import { parseResultSchema } from "./schema";

const raw = {
  course: { title: "Biology 101", subject: "BIOL" },
  categories: [
    { name: "Exams", weight: 60 },
    { name: "Labs", weight: 25 },
    { name: "Homework", weight: 15 },
  ],
  assignments: [
    { title: "Midterm", category_name: "exams", due_date: "2026-03-15", confidence: {} },
    {
      title: "Lab 1",
      category_name: "Laboratory",
      due_date: "2026-02-01T14:30:00",
      confidence: {},
    },
    { title: "Ghost", category_name: "Nonexistent", due_date: "2026-02-02", confidence: {} },
    { title: "Old thing", category_name: null, due_date: "2020-01-01", confidence: {} },
  ],
};

describe("postprocess (items 22-24)", () => {
  const tz = "America/New_York";

  it("defaults missing times to 23:59 local and applies the tz offset", () => {
    const out = postprocess(raw, {
      timezone: tz,
      term_start: "2026-01-15",
      term_end: "2026-05-10",
    });
    const midterm = out.assignments.find((a) => a.title === "Midterm")!;
    expect(midterm.due_at).toBe("2026-03-15T23:59:00-04:00"); // EDT offset in March
    expect(midterm.category_id).not.toBeNull();
  });

  it("keeps an explicit time", () => {
    const out = postprocess(raw, {
      timezone: tz,
      term_start: "2026-01-15",
      term_end: "2026-05-10",
    });
    const lab = out.assignments.find((a) => a.title === "Lab 1")!;
    expect(lab.due_at).toContain("T14:30:00");
  });

  it("fuzzy-matches categories and flags unmatched as null", () => {
    const out = postprocess(raw, {
      timezone: tz,
      term_start: "2026-01-15",
      term_end: "2026-05-10",
    });
    const lab = out.assignments.find((a) => a.title === "Lab 1")!;
    expect(lab.category_id).not.toBeNull(); // "Laboratory" ~ "Labs"
    const ghost = out.assignments.find((a) => a.title === "Ghost")!;
    expect(ghost.category_id).toBeNull();
    expect(out.warnings.some((w) => w.includes("Nonexistent"))).toBe(true);
  });

  it("drops out-of-term dates and dedupes", () => {
    const out = postprocess(raw, {
      timezone: tz,
      term_start: "2026-01-15",
      term_end: "2026-05-10",
    });
    expect(out.assignments.find((a) => a.title === "Old thing")!.dropped).toBe(true);
    const dup = {
      ...raw,
      assignments: [...raw.assignments, raw.assignments[0]!],
    };
    const out2 = postprocess(dup, {
      timezone: tz,
      term_start: "2026-01-15",
      term_end: "2026-05-10",
    });
    expect(out2.assignments.filter((a) => a.title === "Midterm")).toHaveLength(1);
  });

  it("warns when weights do not total ~100", () => {
    const bad = { ...raw, categories: [{ name: "Only", weight: 70 }] };
    const out = postprocess(bad, { timezone: tz });
    expect(out.warnings.some((w) => w.includes("70"))).toBe(true);
  });
});

describe("chunking (item 26)", () => {
  it("keeps short syllabi as one chunk", () => {
    expect(chunkSyllabus("short syllabus")).toHaveLength(1);
  });

  it("splits long syllabi and merges results without duplicates", () => {
    const long = Array.from({ length: 2000 }, (_, i) => `Line ${i} of the syllabus`).join("\n");
    const chunks = chunkSyllabus(long);
    expect(chunks.length).toBeGreaterThan(1);

    const r1 = parseResultSchema.parse({
      course: { title: "T" },
      categories: [{ name: "Exams", weight: 60 }],
      assignments: [{ title: "Midterm", due_date: "2026-03-15", confidence: {} }],
    });
    const r2 = parseResultSchema.parse({
      course: { title: "T" },
      categories: [{ name: "Labs", weight: 40 }],
      assignments: [
        { title: "Midterm", due_date: "2026-03-15", confidence: {} },
        { title: "Lab 1", due_date: "2026-02-01", confidence: {} },
      ],
    });
    const merged = mergeParseResults([r1, r2]);
    expect(merged.categories).toHaveLength(2);
    expect(merged.assignments).toHaveLength(2); // Midterm deduped
  });
});

describe("SSRF protection (item 19)", () => {
  it("blocks private and loopback URLs", () => {
    for (const bad of [
      "http://localhost/x",
      "http://127.0.0.1/x",
      "http://10.0.0.1/x",
      "http://192.168.1.1/x",
      "http://172.16.0.1/x",
      "http://169.254.169.254/latest/meta-data",
      "file:///etc/passwd",
    ]) {
      expect(() => assertSafeUrl(bad)).toThrow();
    }
    expect(() => assertSafeUrl("https://example.edu/syllabus.pdf")).not.toThrow();
  });

  it("strips HTML to text", () => {
    const text = stripHtml(
      "<html><body><h1>BIOL 101</h1><p>Midterm: 30%</p><script>evil()</script></body></html>",
    );
    expect(text).toContain("BIOL 101");
    expect(text).toContain("Midterm: 30%");
    expect(text).not.toContain("evil");
  });
});
