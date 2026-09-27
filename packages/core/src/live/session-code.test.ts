import { describe, expect, it } from "vitest";
import {
  CODE_ALPHABET,
  generateCode,
  isValidCode,
  liveSessionIdFromTopic,
  liveSessionTopic,
  MAX_CODE_LENGTH,
  MIN_CODE_LENGTH,
  normalizeCode,
} from "./session-code";

const UUID = "3f1b1d2e-4a5b-4c6d-8e9f-0a1b2c3d4e5f";

describe("generateCode", () => {
  it("produces codes of the requested length from the alphabet only", () => {
    for (let i = 0; i < 200; i += 1) {
      const code = generateCode(6);
      expect(code).toHaveLength(6);
      for (const char of code) {
        expect(CODE_ALPHABET).toContain(char);
      }
    }
  });

  it("omits characters that get misheard or mistyped", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i += 1) {
      for (const char of generateCode(8)) seen.add(char);
    }
    for (const ambiguous of ["I", "O", "0", "1"]) {
      expect(seen.has(ambiguous)).toBe(false);
    }
  });

  it("honours the length bounds the database enforces", () => {
    expect(() => generateCode(MIN_CODE_LENGTH - 1)).toThrow(RangeError);
    expect(() => generateCode(MAX_CODE_LENGTH + 1)).toThrow(RangeError);
    expect(() => generateCode(6.5)).toThrow(RangeError);
  });

  it("redraws the biased tail instead of folding it in", () => {
    // 0x1_0000_0000 is not a multiple of the alphabet size, so the last few
    // values of the range are over-represented by a naive modulo. Feed a source
    // that returns only those values and assert we never accept one.
    const size = CODE_ALPHABET.length;
    const limit = Math.floor(0x1_0000_0000 / size) * size;
    const draws = [limit, limit + 1, limit + 2, 0, 1, 2];
    let i = 0;
    const code = generateCode(6, () => (draws[i++ % draws.length] as number) / 0x1_0000_0000);

    expect(code).toHaveLength(6);
    expect(isValidCode(code)).toBe(true);
  });

  it("is not deterministic without an injected source", () => {
    expect(generateCode(6)).not.toBe(generateCode(6));
  });
});

describe("isValidCode", () => {
  it("accepts normalised input and rejects the rest", () => {
    expect(isValidCode("ab3c9d")).toBe(true);
    expect(isValidCode("  ab3c9d  ")).toBe(true);
    expect(isValidCode("abc")).toBe(false); // too short
    expect(isValidCode("abcdefghijk")).toBe(false); // too long
    expect(isValidCode("ab3-9d")).toBe(false); // punctuation
    expect(isValidCode("ab3c9!")).toBe(false);
  });

  it("rejects codes containing characters outside the safe alphabet", () => {
    // A code containing I is not one this app would have generated, so accepting
    // it would mean honouring an id we never issued.
    expect(isValidCode("ABCIO1")).toBe(false);
  });
});

describe("normalizeCode", () => {
  it("trims and upper-cases", () => {
    expect(normalizeCode("  ab3c9d ")).toBe("AB3C9D");
  });
});

describe("liveSessionTopic", () => {
  it("round-trips through the parser the SQL policies use", () => {
    expect(liveSessionTopic(UUID)).toBe(`session:${UUID}`);
    expect(liveSessionIdFromTopic(`session:${UUID}`)).toBe(UUID);
  });

  it("returns null for anything it did not mint", () => {
    expect(liveSessionIdFromTopic("session:not-a-uuid")).toBeNull();
    expect(liveSessionIdFromTopic("realtime:public:sessions")).toBeNull();
    expect(liveSessionIdFromTopic("")).toBeNull();
  });
});
