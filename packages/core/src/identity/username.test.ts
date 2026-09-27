import { describe, expect, it } from "vitest";
import {
  allocateUsername,
  fallbackUsernameBase,
  isValidUsername,
  normalizeUsername,
  parseUsername,
  slugifyEmailLocalPart,
  truncateUsername,
  usernameCandidates,
  USERNAME_MAX_LENGTH,
} from "./username";

/**
 * These cases are mirrored by `slug_from_email` and `allocate_username` in
 * migration 0012, and by supabase/tests/profiles_username_tests.sql. If the SQL
 * and this module disagree, a signup produces a username the check constraint
 * rejects -- so run both suites when changing either side.
 */
describe("usernameSchema", () => {
  it("accepts the documented shape", () => {
    expect(isValidUsername("ada")).toBe(true);
    expect(isValidUsername("ada_lovelace")).toBe(true);
    expect(isValidUsername("a1b2c3")).toBe(true);
    expect(isValidUsername("___")).toBe(false); // no leading/trailing underscore
  });

  it("rejects anything outside [a-z0-9_]", () => {
    for (const bad of [
      "ada-lovelace", // hyphen: not in the character set
      "ada.lovelace",
      "ada lovelace",
      "adaLovelace", // uppercase
      "ada@lovelace",
      "ada/lovelace",
      "adá",
      "ada\nlovelace",
    ]) {
      expect(isValidUsername(bad), bad).toBe(false);
    }
  });

  it("enforces the 3-20 length window at both ends", () => {
    expect(isValidUsername("ab")).toBe(false);
    expect(isValidUsername("abc")).toBe(true);
    expect(isValidUsername("a".repeat(20))).toBe(true);
    expect(isValidUsername("a".repeat(21))).toBe(false);
  });

  it("rejects a leading or trailing underscore", () => {
    expect(isValidUsername("_ada")).toBe(false);
    expect(isValidUsername("ada_")).toBe(false);
  });

  it("reserves names that could be mistaken for the app itself", () => {
    expect(isValidUsername("admin")).toBe(false);
    expect(isValidUsername("support")).toBe(false);
    expect(isValidUsername("admins")).toBe(true);
  });

  it("returns the canonical value or null", () => {
    expect(parseUsername("  ada  ")).toBeNull(); // spaces are not normalised away
    expect(parseUsername("ada")).toBe("ada");
    expect(parseUsername(42)).toBeNull();
  });
});

describe("normalizeUsername", () => {
  it("folds case and surrounding whitespace", () => {
    expect(normalizeUsername("  Ana  ")).toBe("ana");
    expect(normalizeUsername("ANA_LOVELACE")).toBe("ana_lovelace");
  });
});

describe("slugifyEmailLocalPart", () => {
  it("takes the local part and keeps the readable shape", () => {
    expect(slugifyEmailLocalPart("ada.lovelace@example.com")).toBe("ada_lovelace");
    expect(slugifyEmailLocalPart("ADA@Example.COM")).toBe("ada");
    expect(slugifyEmailLocalPart("ada+study@example.com")).toBe("ada_study");
  });

  it("collapses runs of disallowed characters into one underscore", () => {
    expect(slugifyEmailLocalPart("ada...lovelace@example.com")).toBe("ada_lovelace");
    expect(slugifyEmailLocalPart("ada--lovelace@example.com")).toBe("ada_lovelace");
    expect(slugifyEmailLocalPart("  ada  @example.com")).toBe("ada");
  });

  it("strips leading and trailing separators", () => {
    expect(slugifyEmailLocalPart(".ada.@example.com")).toBe("ada");
    expect(slugifyEmailLocalPart("+ada@example.com")).toBe("ada");
  });

  it("respects the last @ so quoted local parts do not leak a domain", () => {
    // "weird@local@example.com" is a legal local part; the domain is example.com.
    expect(slugifyEmailLocalPart("weird@local@example.com")).toBe("weird_local");
  });

  it("returns null rather than an empty string when nothing is usable", () => {
    expect(slugifyEmailLocalPart("@example.com")).toBeNull();
    expect(slugifyEmailLocalPart("...")).toBeNull();
    expect(slugifyEmailLocalPart("")).toBeNull();
  });

  it("never exceeds the length limit", () => {
    const slug = slugifyEmailLocalPart(`${"a".repeat(40)}@example.com`);
    expect(slug).toHaveLength(USERNAME_MAX_LENGTH);
  });
});

describe("truncateUsername", () => {
  it("leaves room for the suffix", () => {
    expect(truncateUsername("a".repeat(20), 0)).toHaveLength(20);
    expect(truncateUsername("a".repeat(20), 2)).toHaveLength(18);
    expect(truncateUsername("a".repeat(20) + "_2", 2)).toBe("a".repeat(18));
  });

  it("refuses a suffix that would leave no room", () => {
    expect(() => truncateUsername("abc", 18)).toThrow();
  });
});

describe("usernameCandidates", () => {
  it("numbers collisions with an underscore, because the charset has no hyphen", () => {
    expect(usernameCandidates("ada", 4)).toEqual(["ada", "ada_2", "ada_3", "ada_4"]);
  });

  it("keeps every candidate inside the length limit", () => {
    const base = "a".repeat(20);
    for (const candidate of usernameCandidates(base, 50)) {
      expect(candidate.length, candidate).toBeLessThanOrEqual(USERNAME_MAX_LENGTH);
      expect(isValidUsername(candidate), candidate).toBe(true);
    }
  });

  it("produces the full ladder for a short base, because the limit never bites", () => {
    // The stop condition is about the *base* being squeezed out by a long
    // suffix, and a short base can never be: the suffix is at most three
    // characters, so 20 - 3 leaves 17.
    const candidates = usernameCandidates("ab", 5);
    expect(candidates).toEqual(["ab", "ab_2", "ab_3", "ab_4", "ab_5"]);

    // The bare base is allowed to be invalid here -- a two-character email local
    // part is real -- and it is allocateUsername's job to skip it. The suffixed
    // candidates all clear the minimum length.
    expect(isValidUsername(candidates[0] as string)).toBe(false);
    expect(candidates.slice(1).every(isValidUsername)).toBe(true);
  });
});

describe("allocateUsername", () => {
  it("returns the base when it is free", () => {
    expect(allocateUsername("ada", () => false)).toBe("ada");
  });

  it("walks the suffixes until it finds a free one", () => {
    const taken = new Set(["ada", "ada_2"]);
    expect(allocateUsername("ada", (candidate) => taken.has(candidate))).toBe("ada_3");
  });

  it("skips a reserved candidate even if it is free", () => {
    expect(allocateUsername("admin", () => false)).toBe("admin_2");
  });

  it("gives up rather than looping forever", () => {
    expect(allocateUsername("ada", () => true, 5)).toBeNull();
  });
});

describe("fallbackUsernameBase", () => {
  it("pads to three digits so it is always a valid length", () => {
    expect(fallbackUsernameBase(() => 0)).toBe("user000");
    expect(fallbackUsernameBase(() => 0.999999)).toBe("user999");
    expect(isValidUsername(fallbackUsernameBase(() => 0.5))).toBe(true);
  });
});
