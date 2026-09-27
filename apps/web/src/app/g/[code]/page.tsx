"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import type { StudyGroupPreview } from "@studyly/db";
import AuthPanel from "../../../components/AuthPanel";
import { track, EVENTS } from "../../../lib/analytics";
import { getSupabaseBrowser } from "../../../lib/supabase-browser";
import { useSession } from "../../../lib/use-session";

type Phase =
  | { status: "loading" }
  | { status: "needs-auth" }
  | { status: "invalid" }
  | { status: "full"; preview: StudyGroupPreview }
  | { status: "member"; preview: StudyGroupPreview }
  | { status: "ready"; preview: StudyGroupPreview }
  | { status: "joining"; preview: StudyGroupPreview }
  | { status: "error"; message: string };

/**
 * The invite landing page: /g/<code>.
 *
 * Signing in -- or signing up -- happens right here, so "send the user through
 * signup and return them to this URL" needs no redirect machinery: the page
 * watches the session and picks the flow back up the moment one appears.
 * Redeeming is idempotent server-side, so landing here twice, or as an
 * existing member, is always safe.
 */
export default function InvitePage() {
  const params = useParams<{ code: string | string[] }>();
  const router = useRouter();
  const { session, ready } = useSession();

  // Canonical Crockford codes are uppercase; the server normalises too, this
  // just keeps the two in view of each other.
  const code =
    (Array.isArray(params.code) ? params.code[0] : params.code)?.trim().toUpperCase() ?? "";

  const [phase, setPhase] = useState<Phase>({ status: "loading" });
  const [retryTick, setRetryTick] = useState(0);
  const checkedRef = useRef(false);

  useEffect(() => {
    if (!ready) return;

    if (!session) {
      // Signed out: the next sign-in (possibly a different person) must check
      // the code against that fresh identity.
      checkedRef.current = false;
      setPhase({ status: "needs-auth" });
      return;
    }

    if (checkedRef.current) return;
    checkedRef.current = true;

    let cancelled = false;
    (async () => {
      const supabase = getSupabaseBrowser();

      const { data: previewRows, error: previewError } = await supabase.rpc(
        "study_group_from_invite_code",
        { p_code: code },
      );
      if (cancelled) return;
      if (previewError || !previewRows || previewRows.length === 0) {
        setPhase({ status: "invalid" });
        return;
      }
      const preview = previewRows[0] as StudyGroupPreview;

      // Already a member? Redeem would be a no-op, but saying so beats
      // re-running a join that writes nothing.
      const { data: ownRow } = await supabase
        .from("study_group_members")
        .select("user_id")
        .eq("group_id", preview.id)
        .eq("user_id", session.user.id)
        .limit(1);
      if (cancelled) return;

      if (ownRow && ownRow.length > 0) {
        setPhase({ status: "member", preview });
      } else if (preview.full) {
        setPhase({ status: "full", preview });
      } else {
        setPhase({ status: "ready", preview });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [ready, session, code, retryTick]);

  async function joinGroup(preview: StudyGroupPreview) {
    setPhase({ status: "joining", preview });
    const supabase = getSupabaseBrowser();
    const { data, error } = await supabase.rpc("redeem_invite_code", { p_code: code });

    if (error || !data) {
      if (/no study group matches/i.test(error?.message ?? "")) {
        setPhase({ status: "invalid" });
      } else if (/is full/i.test(error?.message ?? "")) {
        setPhase({ status: "full", preview });
      } else {
        setPhase({ status: "error", message: error?.message ?? "Joining failed. Try again." });
      }
      return;
    }

    track(EVENTS.group_joined, { group_id: data });
    router.push(`/groups/${data}`);
  }

  function retry() {
    checkedRef.current = false;
    setPhase({ status: "loading" });
    setRetryTick((tick) => tick + 1);
  }

  if (phase.status === "loading") {
    return (
      <main className="shell">
        <p>Checking your invite...</p>
      </main>
    );
  }

  if (phase.status === "needs-auth") {
    return (
      <main className="shell invite-page">
        <h1>You've been invited to a study group</h1>
        <AuthPanel
          headline="Sign in to accept the invite"
          note="Creating an account works too — you'll land right back on this page."
        />
      </main>
    );
  }

  if (phase.status === "invalid") {
    return (
      <main className="shell invite-page">
        <section className="card">
          <h1>That invite no longer works</h1>
          <p>
            No group matches this code. Codes are rotated by their group's owner, and an old link
            dies with the code it carried. Ask for a fresh link.
          </p>
          <Link href="/groups" className="button-link">
            Your groups
          </Link>
        </section>
      </main>
    );
  }

  if (phase.status === "full") {
    return (
      <main className="shell invite-page">
        <section className="card">
          <h1>{phase.preview.name} is full</h1>
          <p>
            A study group tops out at 12 members, owner included. Someone has to leave before a
            new invite can land.
          </p>
          <Link href="/groups" className="button-link">
            Your groups
          </Link>
        </section>
      </main>
    );
  }

  if (phase.status === "member") {
    return (
      <main className="shell invite-page">
        <section className="card">
          <h1>You're already in {phase.preview.name}</h1>
          <p>No need to redeem the same invite twice.</p>
          <Link href={`/groups/${phase.preview.id}`} className="button-link">
            Open the group
          </Link>
        </section>
      </main>
    );
  }

  if (phase.status === "error") {
    return (
      <main className="shell invite-page">
        <section className="card">
          <h1>That join didn't go through</h1>
          <p role="alert">{phase.message}</p>
          <button type="button" onClick={retry}>
            Try again
          </button>
        </section>
      </main>
    );
  }

  return (
    <main className="shell invite-page">
      <section className="card">
        <h1>{phase.preview.name}</h1>
        <p>
          {phase.preview.member_count} of 12 members. Joining with code <code>{code}</code>.
        </p>
        <button
          type="button"
          onClick={() => joinGroup(phase.preview)}
          disabled={phase.status === "joining"}
        >
          {phase.status === "joining" ? "Joining..." : "Join group"}
        </button>
      </section>
    </main>
  );
}
