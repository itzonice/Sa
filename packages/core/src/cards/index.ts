/**
 * Item 39: turn user notes into atomic retrieval cards.
 * The edge function calls the model and validates output with these zod schemas;
 * generation quality rules live in the prompt below.
 */

import { z } from "zod";

export const generatedCardSchema = z.object({
  question: z.string().min(8).max(500).describe("One atomic idea, phrased as a question"),
  answer: z.string().min(1).max(1000),
  tags: z.array(z.string().max(40)).max(6).default([]),
});

export const cardGenerationResultSchema = z.object({
  cards: z.array(generatedCardSchema).min(1).max(30),
});

export type GeneratedCard = z.infer<typeof generatedCardSchema>;
export type CardGenerationResult = z.infer<typeof cardGenerationResultSchema>;

/** Client-side heuristic fallback (no LLM): split notes into sentence cards. */
export function cardsFromNotesHeuristic(notes: string): GeneratedCard[] {
  return notes
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 12)
    .slice(0, 20)
    .map((s) => {
      const m = /^(.{3,60}?)\s+(is|are|was|were|means|refers to)\s+(.+)$/i.exec(s);
      if (m) {
        return {
          question: `What ${/s$/.test(m[1]!) ? "are" : "is"} ${m[1]!.replace(/^(the|a|an)\s+/i, "")}?`,
          answer: m[3]!,
          tags: [],
        };
      }
      return { question: `Explain: ${s.slice(0, 80)}`, answer: s, tags: [] };
    });
}

export const cardGenerationPrompt = `You convert study notes into atomic retrieval-practice cards.

Rules:
- One idea per card. If a sentence contains two facts, make two cards.
- Phrase the question so the answer must be retrieved from memory, not recognized.
- Questions must be answerable with the note content only — no outside knowledge.
- Keep answers under 40 words. No card numbering, no meta commentary.

Return the cards via the emit_cards tool.`;
