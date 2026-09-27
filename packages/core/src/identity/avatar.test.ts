import { describe, expect, it } from "vitest";
import {
  ALLOWED_AVATAR_TYPES,
  AVATAR_BUCKET,
  AVATAR_SIGNED_URL_TTL_SECONDS,
  avatarExtensionFor,
  avatarPathFor,
  avatarPathSchema,
  isAllowedAvatarType,
  isOwnAvatarPath,
  MAX_AVATAR_BYTES,
  parseAvatarFile,
  profileLabel,
} from "./avatar";

const USER = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";

describe("avatar buckets and limits", () => {
  it("uses a private bucket, not the public one", () => {
    expect(AVATAR_BUCKET).toBe("avatars");
    // The migration creates it with public = false; a signed URL is the only way
    // out, which is why nothing renders avatar_path directly.
  });

  it("caps size and mime type at the form boundary", () => {
    expect(MAX_AVATAR_BYTES).toBe(2 * 1024 * 1024);
    expect(ALLOWED_AVATAR_TYPES).toEqual(["image/png", "image/jpeg", "image/webp"]);
    expect(isAllowedAvatarType("image/gif")).toBe(false);
    // svg is excluded on purpose: it is a document that can script.
    expect(isAllowedAvatarType("image/svg+xml")).toBe(false);
  });

  it("keeps signed URLs short-lived", () => {
    expect(AVATAR_SIGNED_URL_TTL_SECONDS).toBe(300);
    expect(AVATAR_SIGNED_URL_TTL_SECONDS).toBeLessThanOrEqual(600);
  });
});

describe("avatarPathFor", () => {
  it("builds one canonical key per user so replacements overwrite", () => {
    expect(avatarPathFor(USER, "image/png")).toBe(`${USER}/avatar.png`);
    expect(avatarPathFor(USER, "image/jpeg")).toBe(`${USER}/avatar.jpg`);
    expect(avatarPathFor(USER, "image/webp")).toBe(`${USER}/avatar.webp`);
  });

  it("refuses a mime type the bucket does not accept", () => {
    expect(avatarPathFor(USER, "image/gif")).toBeNull();
    expect(avatarPathFor(USER, "text/html")).toBeNull();
  });

  it("refuses a user id that is not a uuid", () => {
    expect(avatarPathFor("../../etc", "image/png")).toBeNull();
    expect(avatarPathFor("not-a-uuid", "image/png")).toBeNull();
  });
});

describe("isOwnAvatarPath", () => {
  it("accepts your own avatar and nothing else", () => {
    expect(isOwnAvatarPath(USER, `${USER}/avatar.png`)).toBe(true);
    expect(isOwnAvatarPath(USER, `${OTHER}/avatar.png`)).toBe(false);
    expect(isOwnAvatarPath(USER, `${USER}/../../other/avatar.png`)).toBe(false);
    expect(isOwnAvatarPath(USER, `${USER}/syllabus.pdf`)).toBe(false);
    expect(isOwnAvatarPath(USER, null)).toBe(false);
    expect(isOwnAvatarPath(USER, 42)).toBe(false);
  });

  it("anchors the pattern, so a prefix collision is not enough", () => {
    // A uuid-shaped id that merely starts with USER must not pass.
    const lookalike = `${USER}ffff`;
    expect(isOwnAvatarPath(USER, `${lookalike}/avatar.png`)).toBe(false);
    expect(avatarPathSchema(USER).safeParse(`${lookalike}/avatar.png`).success).toBe(false);
  });

  it("is not fooled by regex metacharacters in the user id", () => {
    // A '.' in the id would otherwise widen the pattern.
    expect(isOwnAvatarPath("a.b", "aXb/avatar.png")).toBe(false);
  });
});

describe("parseAvatarFile", () => {
  it("accepts an image under the limit", () => {
    expect(parseAvatarFile({ size: 1024, type: "image/png" })).toEqual({
      size: 1024,
      type: "image/png",
    });
  });

  it("rejects an empty file", () => {
    expect(parseAvatarFile({ size: 0, type: "image/png" })).toBeNull();
  });

  it("rejects a file over the limit", () => {
    expect(parseAvatarFile({ size: MAX_AVATAR_BYTES + 1, type: "image/png" })).toBeNull();
    expect(parseAvatarFile({ size: MAX_AVATAR_BYTES, type: "image/png" })).not.toBeNull();
  });

  it("rejects a disallowed type even when the size is fine", () => {
    expect(parseAvatarFile({ size: 10, type: "application/pdf" })).toBeNull();
    expect(parseAvatarFile({ size: 10, type: "image/svg+xml" })).toBeNull();
  });

  it("rejects a value that is not file-shaped", () => {
    expect(parseAvatarFile(null)).toBeNull();
    expect(parseAvatarFile("avatar.png")).toBeNull();
  });
});

describe("avatarExtensionFor", () => {
  it("maps jpeg to jpg", () => {
    expect(avatarExtensionFor("image/jpeg")).toBe("jpg");
    expect(avatarExtensionFor("image/gif")).toBeNull();
  });
});

describe("profileLabel", () => {
  it("prefers a display name, then the username", () => {
    expect(profileLabel({ display_name: "Ada", username: "ada" })).toBe("Ada");
    expect(profileLabel({ display_name: "   ", username: "ada" })).toBe("ada");
    expect(profileLabel({ display_name: null, username: "ada" })).toBe("ada");
    expect(profileLabel({})).toBe("Someone");
  });
});
