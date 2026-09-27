/**
 * Item 26: chunk long syllabi by section and merge per-chunk parse results.
 */

import type { ParseResult } from "./schema";

const MAX_CHUNK_CHARS = 30_000;

export function chunkSyllabus(text: string): string[] {
  if (text.length <= MAX_CHUNK_CHARS) return [text];

  // Prefer section boundaries (ALL-CAPS headings), then blank lines.
  const lines = text.split("\n");
  const sections: string[] = [];
  let current: string[] = [];
  let size = 0;

  const flush = () => {
    if (current.length) {
      sections.push(current.join("\n"));
      current = [];
      size = 0;
    }
  };

  for (const line of lines) {
    const isHeading = /^[A-Z][A-Z0-9 ,&/().'-]{3,80}$/.test(line.trim());
    if (
      (size + line.length > MAX_CHUNK_CHARS && size > 0) ||
      (isHeading && size > MAX_CHUNK_CHARS / 2)
    ) {
      flush();
    }
    current.push(line);
    size += line.length + 1;
  }
  flush();

  // If chunking produced a single oversized section, hard-split it.
  const out: string[] = [];
  for (const s of sections) {
    if (s.length <= MAX_CHUNK_CHARS) {
      out.push(s);
    } else {
      for (let i = 0; i < s.length; i += MAX_CHUNK_CHARS) {
        out.push(s.slice(i, i + MAX_CHUNK_CHARS));
      }
    }
  }
  return out;
}

function normTitle(t: string): string {
  return t
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function mergeParseResults(results: ParseResult[]): ParseResult {
  if (results.length === 0) {
    return { course: { title: "Untitled course" }, categories: [], assignments: [] };
  }
  const [first, ...rest] = results;
  if (!first) {
    return { course: { title: "Untitled course" }, categories: [], assignments: [] };
  }
  const merged: ParseResult = {
    course: { ...first.course },
    categories: [...first.categories],
    assignments: [...first.assignments],
  };

  for (const r of rest) {
    // Course metadata: keep the most complete values.
    if (!merged.course.subject && r.course.subject) merged.course.subject = r.course.subject;
    if (!merged.course.term_start && r.course.term_start)
      merged.course.term_start = r.course.term_start;
    if (!merged.course.term_end && r.course.term_end) merged.course.term_end = r.course.term_end;

    for (const cat of r.categories) {
      const existing = merged.categories.find(
        (c) => c.name.toLowerCase() === cat.name.toLowerCase(),
      );
      if (!existing) {
        merged.categories.push(cat);
      } else if (!existing.weight && cat.weight) {
        existing.weight = cat.weight;
      }
    }

    const seen = new Set(merged.assignments.map((a) => normTitle(a.title)));
    for (const a of r.assignments) {
      const key = normTitle(a.title);
      if (!seen.has(key)) {
        merged.assignments.push(a);
        seen.add(key);
      }
    }
  }
  return merged;
}
