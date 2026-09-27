/**
 * Item 21: AI parse call with structured output.
 * Claude Opus 5 by default, PARSER_MODEL override. Retries with backoff,
 * hard timeout, explicit refusal handling, zod validation of output.
 */

import Anthropic from "@anthropic-ai/sdk";
import {
  parseResultSchema,
  PARSER_PROMPT_VERSION,
  type ParseResult,
  type ParserInput,
} from "./schema";
import { parsePromptV1 } from "./prompt";
import { chunkSyllabus, mergeParseResults } from "./chunk";
import { requireApiKey, parserModel } from "../env";

const MAX_TOKENS = 8_000;
const TIMEOUT_MS = 60_000;
const MAX_ATTEMPTS = 3;

export type ParseOutcome =
  | { ok: true; result: ParseResult; promptVersion: string; model: string }
  | { ok: false; error: string; refused: boolean; promptVersion: string };

export async function parseSyllabus(input: ParserInput): Promise<ParseOutcome> {
  const chunks = chunkSyllabus(input.text);
  const model = parserModel();

  try {
    const results: ParseResult[] = [];
    for (const chunk of chunks) {
      const res = await callModel({ ...input, text: chunk }, model);
      if (!res.ok) return { ...res, promptVersion: PARSER_PROMPT_VERSION };
      results.push(res.result);
    }
    const merged = mergeParseResults(results);
    const validated = parseResultSchema.safeParse(merged);
    if (!validated.success) {
      return {
        ok: false,
        error: `Schema validation failed: ${validated.error.message}`,
        refused: false,
        promptVersion: PARSER_PROMPT_VERSION,
      };
    }
    return { ok: true, result: validated.data, promptVersion: PARSER_PROMPT_VERSION, model };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Unknown parser error",
      refused: false,
      promptVersion: PARSER_PROMPT_VERSION,
    };
  }
}

async function callModel(
  input: ParserInput,
  model: string,
): Promise<{ ok: true; result: ParseResult } | { ok: false; error: string; refused: boolean }> {
  const client = new Anthropic({ apiKey: requireApiKey(), timeout: TIMEOUT_MS });
  const system = parsePromptV1(input);

  let lastError = "unknown";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await client.messages.create({
        model,
        max_tokens: MAX_TOKENS,
        system,
        messages: [{ role: "user", content: input.text }],
        tools: [
          {
            name: "emit_parse_result",
            description: "Emit the extracted syllabus structure",
            input_schema: { type: "object" }, // refined by validation below
          },
        ],
        tool_choice: { type: "tool", name: "emit_parse_result" },
      });

      // Older SDK typings omit "refusal" from stop_reason; the runtime value exists.
      const refused = (response.stop_reason as string) === "refusal";
      if (refused) {
        return {
          ok: false,
          error: "Model refused to parse this content",
          refused: true,
        };
      }

      const toolBlock = response.content.find((b) => b.type === "tool_use");
      if (!toolBlock || toolBlock.type !== "tool_use") {
        lastError = "No tool_use block in response";
        continue;
      }

      const validated = parseResultSchema.safeParse(toolBlock.input);
      if (!validated.success) {
        lastError = `Validation failed: ${validated.error.message}`;
        continue;
      }
      return { ok: true, result: validated.data };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (attempt < MAX_ATTEMPTS) {
        await sleep(500 * 2 ** (attempt - 1) + Math.random() * 250);
      }
    }
  }
  return {
    ok: false,
    error: `Parse failed after ${MAX_ATTEMPTS} attempts: ${lastError}`,
    refused: false,
  };
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
