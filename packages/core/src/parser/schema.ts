import { z } from "zod";

export const PARSER_PROMPT_VERSION = "v1";

export const confidenceSchema = z
  .object({
    inferred_date: z.boolean().optional(),
    inferred_year: z.boolean().optional(),
    expanded_recurring: z.boolean().optional(),
  })
  .default({});

export const categorySchema = z.object({
  name: z.string().min(1).max(100),
  weight: z.number().min(0).max(100),
  drop_lowest_n: z.number().int().min(0).optional(),
});

export const assignmentSchema = z.object({
  title: z.string().min(1).max(300),
  category_name: z.string().max(100).nullish(),
  due_date: z.string().min(1), // ISO with offset or bare date; normalized in postprocess
  max_score: z.number().positive().optional(),
  description: z.string().max(2000).nullish(),
  confidence: confidenceSchema,
});

export const parseResultSchema = z.object({
  course: z.object({
    title: z.string().min(1),
    subject: z.string().max(20).nullish(),
    term_start: z.string().nullish(),
    term_end: z.string().nullish(),
  }),
  categories: z.array(categorySchema).default([]),
  assignments: z.array(assignmentSchema).default([]),
});

export type ParseResult = z.infer<typeof parseResultSchema>;
export type ParsedAssignment = z.infer<typeof assignmentSchema>;
export type ParsedCategory = z.infer<typeof categorySchema>;

/** Input bundle handed to the model (and to the prompt builder). */
export const parserInputSchema = z.object({
  text: z.string().min(1),
  timezone: z.string().min(1),
  term_start: z.string().optional(),
  term_end: z.string().optional(),
  today: z.string().optional(),
});
export type ParserInput = z.infer<typeof parserInputSchema>;
