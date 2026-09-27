import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { ParserInput } from "./schema";

const here = dirname(fileURLToPath(import.meta.url));

export function parsePromptV1(input: ParserInput): string {
  const template = readFileSync(join(here, "prompt.md"), "utf8");
  const context = [
    `timezone: ${input.timezone}`,
    `term_start: ${input.term_start ?? "(unknown)"}`,
    `term_end: ${input.term_end ?? "(unknown)"}`,
    `today: ${input.today ?? new Date().toISOString().slice(0, 10)}`,
  ].join("\n");
  return `${template}\n\n## Current parse context\n${context}`;
}
