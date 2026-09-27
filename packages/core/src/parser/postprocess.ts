/**
 * Items 22, 23, 24: post-process raw parse output.
 * - Convert dates to the user's timezone; default missing times to 23:59 local.
 * - Drop out-of-term dates (when term bounds are known).
 * - Dedupe near-identical assignments.
 * - Fuzzy-match category_name to categories; unmatched stay null (flagged).
 * - Warn when weights don't total ~100.
 */

import { TZDate } from "@date-fns/tz";
import { type ParseResult, type ParsedAssignment, type ParsedCategory } from "./schema";

export type PostProcessed = {
  course: ParseResult["course"];
  categories: ParsedCategory[];
  assignments: PostProcessedAssignment[];
  warnings: string[];
};

export type PostProcessedAssignment = ParsedAssignment & {
  /** Final due_at, ISO 8601 with offset, in the user's timezone. */
  due_at: string;
  category_id: string | null;
  dropped: boolean;
  drop_reason: string | null;
};

function tzOffsetIso(datePart: string, timePart: string, timezone: string): string {
  // Build a wall-clock timestamp in the target timezone, expressed as ISO with offset.
  const t = timePart.length === 5 ? `${timePart}:00` : timePart; // normalize HH:MM -> HH:MM:SS
  const wall = `${datePart}T${t}`;
  const asUtc = new Date(`${wall}Z`);
  const shifted = new TZDate(asUtc.getTime(), timezone);
  const offsetMin = -shifted.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${datePart}T${t}${sign}${hh}:${mm}`;
}

export function postprocess(
  raw: ParseResult,
  opts: { timezone: string; term_start?: string | undefined; term_end?: string | undefined },
): PostProcessed {
  const warnings: string[] = [];

  // ---- Category fuzzy matching (item 23) ----
  const categories = raw.categories;
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  const stem = (w: string) => w.replace(/(ies|y|es|s|ous|ory|atory)$/u, "");
  const matchCategory = (name: string | null | undefined): ParsedCategory | null => {
    if (!name) return null;
    const n = norm(name);
    if (!n) return null;
    let best: ParsedCategory | null = null;
    let bestScore = 0;
    for (const c of categories) {
      const cn = norm(c.name);
      let score = 0;
      if (cn === n) score = 1;
      else {
        // Word-level overlap with light stemming so "Laboratory" ~ "Labs",
        // "Problem Sets" ~ "Problem Set", "Exam" ~ "Exams".
        const aWords = n.split(" ").map(stem);
        const bWords = new Set(cn.split(" ").map(stem));
        let inter = 0;
        for (const w of new Set(aWords)) {
          if (bWords.has(w)) inter++;
          else if ([...bWords].some((b) => b.startsWith(w) || w.startsWith(b))) inter += 0.9;
        }
        score = inter / Math.max(new Set(aWords).size, bWords.size);
      }
      if (score > bestScore) {
        best = c;
        bestScore = score;
      }
    }
    return bestScore >= 0.5 ? best : null;
  };

  // Category ids are assigned at insert time in SQL; here we attach a stable
  // placeholder id (index-based) the RPC resolves by name.
  const catIdByName = new Map(categories.map((c, i) => [norm(c.name), `cat_${i}`]));

  // ---- Assignments ----
  const seen = new Set<string>();
  const assignments: PostProcessedAssignment[] = [];

  for (const a of raw.assignments) {
    // Date normalization (item 22)
    const m = /^(\d{4}-\d{2}-\d{2})/.exec(a.due_date);
    if (!m) {
      warnings.push(`Assignment "${a.title}" has unparseable date "${a.due_date}" — dropped`);
      continue;
    }
    const datePart = m[1]!;
    const hasTime = /T\d{2}:\d{2}/.test(a.due_date);
    const timePart = hasTime
      ? (/T(\d{2}:\d{2})(?::\d{2})?/.exec(a.due_date)![1] ?? "23:59")
      : "23:59";
    const dueIso = tzOffsetIso(datePart, hasTime ? timePart : "23:59", opts.timezone);

    // Out-of-term drop
    let dropped = false;
    let dropReason: string | null = null;
    const ts = opts.term_start ? new Date(`${opts.term_start}T00:00:00`) : null;
    const te = opts.term_end ? new Date(`${opts.term_end}T23:59:59`) : null;
    const due = new Date(dueIso);
    if (ts && due < ts) {
      dropped = true;
      dropReason = "before term start";
    } else if (te && due > te) {
      dropped = true;
      dropReason = "after term end";
    }

    const key = `${norm(a.title)}@${datePart}`;
    if (seen.has(key)) {
      continue; // dedupe (item 22)
    }
    seen.add(key);

    const cat = matchCategory(a.category_name ?? null);
    if (a.category_name && !cat) {
      warnings.push(
        `Category "${a.category_name}" did not match any extracted category (assignment "${a.title}")`,
      );
    }

    assignments.push({
      ...a,
      due_at: dueIso,
      category_id: cat ? (catIdByName.get(norm(cat.name)) ?? null) : null,
      dropped,
      drop_reason: dropReason,
    });
  }

  // ---- Weight total warning (item 23) ----
  const total = categories.reduce((s, c) => s + c.weight, 0);
  if (categories.length > 0 && (total < 95 || total > 105)) {
    warnings.push(`Category weights total ${total}, expected ~100`);
  }

  return { course: raw.course, categories, assignments, warnings };
}
