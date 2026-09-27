"use client";

import React, { useEffect, useRef, useState } from "react";
import {
  MAX_AVATAR_BYTES,
  USERNAME_MAX_LENGTH,
  RESERVED_USERNAMES,
  usernameSchema,
} from "@studyly/core/identity";

interface SettingsFormProps {
  initialUsername: string | null;
  initialDisplayName: string | null;
  initialAvatarPath: string | null;
  initialShareTaskTitles: boolean;
}

type SaveState = "idle" | "saving" | "saved" | "error";

/**
 * Profile identity settings (G1).
 *
 * The username and display name go to the JSON API, the avatar is a multipart
 * upload to the private `avatars` bucket, and the avatar <img> renders a
 * short-lived signed URL fetched per mount — never a stored URL, because the
 * bucket is private and every signed URL dies after five minutes.
 */
export default function SettingsForm({
  initialUsername,
  initialDisplayName,
  initialAvatarPath,
  initialShareTaskTitles,
}: SettingsFormProps) {
  const [username, setUsername] = useState(initialUsername ?? "");
  const [displayName, setDisplayName] = useState(initialDisplayName ?? "");
  const [shareTaskTitles, setShareTaskTitles] = useState(initialShareTaskTitles);
  const [avatarPath, setAvatarPath] = useState(initialAvatarPath);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  /** Signed URLs expire, so the avatar is fetched fresh whenever the path changes. */
  useEffect(() => {
    let cancelled = false;
    setAvatarUrl(null);

    if (!avatarPath) return () => {};

    (async () => {
      try {
        const res = await fetch("/api/profile/avatar");
        if (!res.ok) return;
        const body = await res.json();
        if (!cancelled && body?.data?.avatar_url) {
          setAvatarUrl(body.data.avatar_url);
        }
      } catch {
        // A missing avatar image is not worth an error banner.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [avatarPath]);

  /** Live, local validation using the same zod schema the API enforces. */
  const usernameError = (() => {
    if (username.length === 0) return null;
    const parsed = usernameSchema.safeParse(username.trim().toLowerCase());
    if (parsed.success) return null;
    return parsed.error.issues[0]?.message ?? "Invalid username.";
  })();

  const handleAvatarChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    // Client-side pre-validation mirrors the API so a rejected upload never
    // leaves the browser.
    if (file.size > MAX_AVATAR_BYTES) {
      setMessage(`Avatars must be ${Math.floor(MAX_AVATAR_BYTES / (1024 * 1024))} MB or smaller.`);
      return;
    }

    setSaveState("saving");
    setMessage(null);

    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/profile/avatar", { method: "POST", body: form });
      const body = await res.json();

      if (!res.ok) {
        setMessage(body?.error?.message ?? "Upload failed.");
        setSaveState("error");
        return;
      }

      // The response is the canonical path; the effect above re-signs it.
      setAvatarPath(body.data.avatar_path);
      setSaveState("saved");
    } catch {
      setMessage("Upload failed. Check your connection and try again.");
      setSaveState("error");
    }
  };

  const handleRemoveAvatar = async () => {
    setSaveState("saving");
    try {
      const res = await fetch("/api/profile/avatar", { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setMessage(body?.error?.message ?? "Could not remove the avatar.");
        setSaveState("error");
        return;
      }
      setAvatarPath(null);
      setSaveState("saved");
    } catch {
      setMessage("Could not remove the avatar.");
      setSaveState("error");
    }
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();

    const parsed = usernameSchema.safeParse(username.trim().toLowerCase());
    if (!parsed.success) {
      setMessage(parsed.error.issues[0]?.message ?? "Invalid username.");
      setSaveState("error");
      return;
    }
    if ((RESERVED_USERNAMES as readonly string[]).includes(parsed.data)) {
      setMessage("That username is reserved.");
      setSaveState("error");
      return;
    }

    setSaveState("saving");
    setMessage(null);

    try {
      const res = await fetch("/api/profile/username", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: parsed.data, display_name: displayName.trim() || null }),
      });
      const body = await res.json();

      if (!res.ok) {
        setMessage(body?.error?.message ?? "Could not save your profile.");
        setSaveState("error");
        return;
      }

      setUsername(body.data.username);
      setSaveState("saved");
    } catch {
      setMessage("Could not save your profile. Check your connection and try again.");
      setSaveState("error");
    }
  };

  return (
    <form onSubmit={handleSubmit}>
      <div>
        <label htmlFor="username">
          Username{" "}
          <span aria-hidden="true">
            ({username.trim().toLowerCase().length}/{USERNAME_MAX_LENGTH})
          </span>
        </label>
        <input
          id="username"
          type="text"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
          maxLength={USERNAME_MAX_LENGTH + 5}
          aria-invalid={usernameError ? true : undefined}
        />
        {usernameError && (
          <p role="alert" className="field-error">
            {usernameError}
          </p>
        )}
        <p className="field-hint">
          3-20 characters: lowercase letters, numbers, underscores. This is your
          public handle — your email is never shared.
        </p>
      </div>

      <div>
        <label htmlFor="displayName">Display name</label>
        <input
          id="displayName"
          type="text"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          maxLength={60}
          placeholder="Shown next to your username (optional)"
        />
      </div>

      <div>
        <span>Avatar</span>
        {avatarUrl ? (
          // Signed URL, minted per render. This never renders avatar_path itself.
          <img src={avatarUrl} alt="Your avatar" width={64} height={64} />
        ) : (
          <span className="avatar-placeholder" aria-hidden="true" />
        )}
        <input
          ref={fileInputRef}
          id="avatar"
          type="file"
          accept="image/png,image/jpeg,image/webp"
          onChange={handleAvatarChange}
          style={{ display: "none" }}
        />
        <button type="button" onClick={() => fileInputRef.current?.click()}>
          {avatarPath ? "Replace avatar" : "Upload avatar"}
        </button>
        {avatarPath && (
          <button type="button" onClick={handleRemoveAvatar}>
            Remove
          </button>
        )}
        <p className="field-hint">PNG, JPEG or WebP, up to 2 MB.</p>
      </div>

      <div>
        <label>
          <input
            type="checkbox"
            checked={shareTaskTitles}
            onChange={(e) => setShareTaskTitles(e.target.checked)}
          />
          Share task titles in recap cards
        </label>
      </div>

      <button type="submit" disabled={saveState === "saving" || Boolean(usernameError)}>
        {saveState === "saving" ? "Saving…" : "Save settings"}
      </button>

      {saveState === "saved" && !message && <p className="saved-note">Saved.</p>}
      {message && (
        <p role="alert" className="field-error">
          {message}
        </p>
      )}
    </form>
  );
}
