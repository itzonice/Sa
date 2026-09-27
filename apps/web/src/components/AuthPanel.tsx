"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { useSession } from "../lib/use-session";

type AuthPanelProps = {
  /** One-line context above the form, e.g. "Sign in to join this group". */
  headline?: ReactNode;
  /** Optional fine print under the form (what happens next, where this goes). */
  note?: ReactNode;
};

/**
 * The sign-in / sign-up form used wherever a page needs a session before it
 * can do anything: the invite page and the groups list. It owns no redirects
 * on purpose -- pages react to the session appearing via useSession, so
 * "sign up and come back to this URL" is just staying on the page.
 */
export default function AuthPanel({ headline, note }: AuthPanelProps) {
  const { signIn, signUp } = useSession();
  const [mode, setMode] = useState<"sign-in" | "sign-up">("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setNotice(null);

    const trimmedEmail = email.trim();
    if (!trimmedEmail || !password) {
      setError("Enter your email and a password.");
      return;
    }

    setBusy(true);
    try {
      if (mode === "sign-in") {
        const message = await signIn(trimmedEmail, password);
        if (message) setError(message);
      } else {
        const outcome = await signUp(trimmedEmail, password);
        if (outcome.error) {
          setError(outcome.error);
        } else if (outcome.needsConfirmation) {
          setNotice("Check your inbox to confirm your email, then come right back here.");
        }
      }
    } finally {
      setBusy(false);
    }
  }

  function switchMode() {
    setMode(mode === "sign-in" ? "sign-up" : "sign-in");
    setError(null);
    setNotice(null);
  }

  return (
    <section className="card auth-panel">
      {headline && <h2 className="panel-headline">{headline}</h2>}
      <form onSubmit={handleSubmit} className="stack">
        <label className="field">
          Email
          <input
            type="email"
            name="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
        </label>
        <label className="field">
          Password
          <input
            type="password"
            name="password"
            autoComplete={mode === "sign-in" ? "current-password" : "new-password"}
            minLength={6}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </label>
        <button type="submit" disabled={busy}>
          {busy ? "One moment..." : mode === "sign-in" ? "Sign in" : "Create account"}
        </button>
      </form>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {notice && <p className="form-note">{notice}</p>}
      <p className="form-note">
        {mode === "sign-in" ? "New here? " : "Already have an account? "}
        <button type="button" className="link-button" onClick={switchMode}>
          {mode === "sign-in" ? "Create an account" : "Sign in instead"}
        </button>
      </p>
      {note && <p className="form-note">{note}</p>}
    </section>
  );
}
