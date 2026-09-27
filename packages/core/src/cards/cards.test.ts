import { describe, it, expect } from "vitest";
import { cardsFromNotesHeuristic, cardGenerationResultSchema } from "./index";

describe("cards (item 39)", () => {
  it("converts definition sentences into atomic Q/A cards", () => {
    const cards = cardsFromNotesHeuristic(
      "Osmosis is the movement of water across a semipermeable membrane. Mitochondria are the powerhouse of the cell.",
    );
    expect(cards.length).toBe(2);
    expect(cards[0]!.question).toMatch(/osmosis/i);
    expect(cards[0]!.answer).toContain("membrane");
  });

  it("validates generated card shape with zod", () => {
    const parsed = cardGenerationResultSchema.safeParse({
      cards: [{ question: "What year did the war end?", answer: "1945", tags: ["history"] }],
    });
    expect(parsed.success).toBe(true);
    const bad = cardGenerationResultSchema.safeParse({ cards: [{ question: "x", answer: "" }] });
    expect(bad.success).toBe(false);
  });
});
