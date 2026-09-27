"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { StudyGroup } from "@studyly/db";
import AuthPanel from "../../components/AuthPanel";
import { track, EVENTS } from "../../lib/analytics";
import { getSupabaseBrowser } from "../../lib/supabase-browser";
import { useSession } from "../../lib/use-session";

/**
 * The groups home: your groups, a create form, and a code box that routes
 * through the invite page (/g/<code>) instead of joining inline -- one code
 * path, so full-group checks, rotation and idempotency live in exactly one
 * place.
 */
export default function GroupsPage() {
  const router = useRouter();
  const { session, ready, signOut } = useSession();

  const [groups, setGroups] = useState<StudyGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [newGroupName, setNewGroupName] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // RLS does the filtering: the member-only select policy returns exactly the
  // caller's groups, and no directory query exists to write.
  const load = useCallback(async () => {
    const supabase = getSupabaseBrowser();
    const { data, error: loadError } = await supabase
      .from("study_groups")
      .select("id, owner_id, name, invite_code, invite_code_rotated_at, created_at")
      .order("created_at", { ascending: true });
    if (loadError) {
      setError(loadError.message);
      return;
    }
    setError(null);
    setGroups((data as StudyGroup[] | null) ?? []);
  }, []);

  useEffect(() => {
    if (!ready || !session) return;
    setLoading(true);
    void load().finally(() => setLoading(false));
  }, [ready, session, load]);

  async function createGroup(event: FormEvent) {
    event.preventDefault();
    const name = newGroupName.trim();
    if (!name) {
      setError("Give the group a name.");
      return;
    }

    setBusy(true);
    const supabase = getSupabaseBrowser();
    // The client supplies the id: a retry after a timeout returns the same
    // group instead of minting a second one (create_study_group contract).
    const { data, error: createError } = await supabase.rpc("create_study_group", {
      p_group_id: crypto.randomUUID(),
      p_name: name,
    });
    setBusy(false);

    if (createError || !data) {
      setError(createError?.message ?? "Creating the group failed. Try again.");
      return;
    }

    track(EVENTS.group_created, { group_id: (data as StudyGroup).id });
    setNewGroupName("");
    setError(null);
    await load();
  }

  function goToInvite(event: FormEvent) {
    event.preventDefault();
    const code = joinCode.trim().toUpperCase();
    if (!code) {
      setError("Paste the six-character code from your invite link.");
      return;
    }
    router.push(`/g/${code}`);
  }

  if (!ready) {
    return (
      <main className="shell">
        <p>Loading...</p>
      </main>
    );
  }

  if (!session) {
    return (
      <main className="shell groups-page">
        <h1>Study groups</h1>
        <AuthPanel headline="Sign in to see your study groups" />
      </main>
    );
  }

  return (
    <main className="shell groups-page">
      <header className="page-head">
        <h1>Study groups</h1>
        <button type="button" className="link-button" onClick={() => void signOut()}>
          Sign out
        </button>
      </header>

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      <section>
        <h2>Your groups</h2>
        {loading ? (
          <p>Loading your groups...</p>
        ) : groups.length === 0 ? (
          <p>No groups yet. Create one below, or paste an invite code.</p>
        ) : (
          <ul className="group-list">
            {groups.map((group) => (
              <li key={group.id} className="card group-row">
                <Link href={`/groups/${group.id}`} className="group-link">
                  <strong>{group.name}</strong>
                  <span className="muted">
                    {group.owner_id === session.user.id ? "You own this group" : "Member"}
                  </span>
                </Link>
                <code className="chip">{group.invite_code}</code>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card stack">
        <h2>Create a group</h2>
        <form onSubmit={createGroup} className="row">
          <input
            type="text"
            placeholder="Group name (e.g. Calculus Squad)"
            value={newGroupName}
            maxLength={80}
            onChange={(event) => setNewGroupName(event.target.value)}
          />
          <button type="submit" disabled={busy}>
            {busy ? "Creating..." : "Create"}
          </button>
        </form>
      </section>

      <section className="card stack">
        <h2>Have an invite code?</h2>
        <form onSubmit={goToInvite} className="row">
          <input
            type="text"
            placeholder="Six-character code (e.g. G3TEST)"
            value={joinCode}
            maxLength={6}
            onChange={(event) => setJoinCode(event.target.value.toUpperCase())}
          />
          <button type="submit">Open invite</button>
        </form>
        <p className="muted">
          Codes arrive as links — <code>/g/&lt;code&gt;</code> — and joining is handled there.
        </p>
      </section>
    </main>
  );
}
