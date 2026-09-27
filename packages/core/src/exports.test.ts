import { describe, it, expect } from "vitest";
import { toAnkiCsv, toQuizletTsv } from "./exports";

const cards = [
  {
    question: "What is osmosis?",
    answer: "Water moving across a semipermeable membrane",
    tags: ["bio", "ch2"],
  },
  { question: "Define: integral", answer: "Antiderivative, area under curve", tags: [] },
];

describe("exports (item 37)", () => {
  it("Anki CSV: proper escaping and header", () => {
    const csv = toAnkiCsv(cards);
    expect(csv.startsWith("#separator:Comma")).toBe(true);
    expect(csv.includes('"What is osmosis?"')).toBe(false); // no quoting needed
    expect(csv.includes("bio ch2")).toBe(true);
  });

  it("Anki CSV escapes commas and quotes", () => {
    const csv = toAnkiCsv([{ question: "Say: hello, world", answer: 'He said "hi"', tags: [] }]);
    expect(csv).toContain('"Say: hello, world"');
    expect(csv).toContain('"He said ""hi"""');
  });

  it("Quizlet TSV: tab-separated, no tabs inside fields", () => {
    const tsv = toQuizletTsv(cards);
    const lines = tsv.trim().split("\n");
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      const [q, a] = line.split("\t");
      expect(q).toBeTruthy();
      expect(a).toBeTruthy();
    }
  });
});
