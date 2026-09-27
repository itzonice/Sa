"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import type { StudyGroup, StudyGroupActivity } from "@studyly/db";
import AuthPanel from "../../../components/AuthPanel";
import { getSupabaseBrowser } from "../../../lib/supabase-browser";
import { useSession } from "../../../lib/use-session";

type MemberRow = {
  user_id: string;
  role: "owner" | "member";
  joined_at: string;
  profiles: { display_name: string | null; avatar_url: string | null } | null;
};

type ActivityRow = StudyGroupActivity & {
  profiles: { display_name: string | null } | null;
};

type Detail =
  | { status: "loading" }
  | { status: "missing" }
  | { status: "ready"; group: StudyGroup; members: MemberRow[]; activity: ActivityRow[] };

function memberName(member: MemberRow): string {
  return member.profiles?.display_name ?? member.user_id.slice(0, 8);
}

/**
 * "Removed a member" deliberately names no one: once someone is out of the
 * group their profile is no longer readable by its members, and the ledger
 * should not keep shouting a name RLS has already taken back.
 */
function activityText(entry: ActivityRow, members: MemberRow[]): string {
  switch (entry.kind) {
    case "joined":
      return "joined the group.";
    case "left":
      return "left.";
    case "removed":
      return "removed a member.";
    case "code_rotated":
      return "rotated the invite code.";
    case "transferred": {
      const toUserId = (entry.detail as { to_user_id?: string } | null)?.to_user_id ?? null;
      const toMember = toUserId ? members.find((member) => member.user_id === toUserId) : null;
      return `handed the group to ${toMember ? memberName(toMember) : "another member"}.`;
    }
  }
}

/**
 * A group's home: who is in it, what happened to it lately, and the one invite
 * link that matters. Every mutation goes through the G3 RPCs so the ledger
 * stays truthful -- remove, rotate and transfer are owner-only, leave is
 * member-wide, and the owner has to hand the group over before walking out.
 */
export default function GroupDetailPage() {
  const params = useParams<{ id: string }>();
  const groupId = Array.isArray(params.id) ? params.id[0] : params.id;
  const router = useRouter();
  const { session, ready } = useSession();

  const [detail, setDetail] = useState<Detail>({ status: "loading" });
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const supabase = getSupabaseBrowser();

    const { data: group, error: groupError } = await supabase
      .from("study_groups")
      .select("id, owner_id, name, invite_code, invite_code_rotated_at, created_at")
      .eq("id", groupId)
      .maybeSingle();

    if (groupError) {
      setError(groupError.message);
      return;
    }
    if (!group) {
      // RLS hides other people's groups as if they did not exist.
      setDetail({ status: "missing" });
      return;
    }

    const { data: members, error: membersError } = await supabase
      .from("study_group_members")
      .select("user_id, role, joined_at, profiles(display_name, avatar_url)")
      .eq("group_id", groupId)
      .order("joined_at", { ascending: true });

    const { data: activity, error: activityError } = await supabase
      .from("study_group_activity")
      .select("id, group_id, actor_id, kind, detail, created_at, profiles(display_name)")
      .eq("group_id", groupId)
      .order("created_at", { ascending: false })
      .limit(50);

    if (membersError || activityError) {
      setError(membersError?.message ?? activityError?.message ?? "Loading the group failed.");
      return;
    }

    setError(null);
    // The client is untyped (hand-written row types, no generated schema), so
    // supabase-js cannot know that the profiles embed is a many-to-one object at
    // runtime -- it types every embed as an array. The double cast is the honest
    // way over that gap.
    setDetail({
      status: "ready",
      group: group as StudyGroup,
      members: (members as unknown as MemberRow[] | null) ?? [],
      activity: (activity as unknown as ActivityRow[] | null) ?? [],
    });
    setInviteLink(`${window.location.origin}/g/${(group as StudyGroup).invite_code}`);
  }, [groupId]);

  useEffect(() => {
    if (!ready || !session) return;
    void load();
  }, [ready, session, load]);

  const isOwner = detail.status === "ready" && session != null && detail.group.owner_id === session.user.id;

  async function rotateCode() {
    if (!window.confirm("Rotate the invite code? The old link stops working immediately.")) return;
    setBusy(true);
    const supabase = getSupabaseBrowser();
    const { error: rotateError } = await supabase.rpc("rotate_invite_code", {
      p_group_id: groupId,
    });
    setBusy(false);
    if (rotateError) {
      setError(rotateError.message);
      return;
    }
    setCopied(false);
    await load();
  }

  async function removeMember(member: MemberRow) {
    if (
      !window.confirm(
        `Remove ${memberName(member)} from the group? They lose access immediately.`,
      )
    ) {
      return;
    }
    setBusy(true);
    const supabase = getSupabaseBrowser();
    const { error: removeError } = await supabase.rpc("remove_member", {
      p_group_id: groupId,
      p_user_id: member.user_id,
    });
    setBusy(false);
    if (removeError) {
      setError(removeError.message);
      return;
    }
    await load();
  }

  async function makeOwner(member: MemberRow) {
    if (
      !window.confirm(`Hand the group to ${memberName(member)}? You step down to a regular member.`)
    ) {
      return;
    }
    setBusy(true);
    const supabase = getSupabaseBrowser();
    const { error: transferError } = await supabase.rpc("transfer_owner", {
      p_group_id: groupId,
      p_new_owner: member.user_id,
    });
    setBusy(false);
    if (transferError) {
      setError(transferError.message);
      return;
    }
    await load();
  }

  async function leaveGroup() {
    if (!window.confirm("Leave this group? You'll need a fresh invite to come back.")) return;
    setBusy(true);
    const supabase = getSupabaseBrowser();
    const { error: leaveError } = await supabase.rpc("leave_group", { p_group_id: groupId });
    setBusy(false);
    if (leaveError) {
      // The one expected case: the owner cannot leave until they hand over.
      setError(leaveError.message);
      return;
    }
    router.push("/groups");
  }

  async function copyInviteLink() {
    if (!inviteLink) return;
    try {
      await navigator.clipboard.writeText(inviteLink);
      setCopied(true);
    } catch {
      setError("Copying failed — select the link and copy it manually.");
    }
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
      <main className="shell group-page">
        <h1>Study group</h1>
        <AuthPanel headline="Sign in to open this group" />
      </main>
    );
  }

  if (detail.status === "loading") {
    return (
      <main className="shell">
        <p>Loading the group...</p>
      </main>
    );
  }

  if (detail.status === "missing") {
    return (
      <main className="shell group-page">
        <section className="card">
          <h1>Group not found</h1>
          <p>Either this link is wrong, or the group is not yours to see.</p>
          <Link href="/groups" className="button-link">
            Your groups
          </Link>
        </section>
      </main>
    );
  }

  const { group, members, activity } = detail;

  return (
    <main className="shell group-page">
      <header className="page-head">
        <h1>{group.name}</h1>
        <Link href="/groups" className="button-link">
          All groups
        </Link>
      </header>

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      <section>
        <h2>Members ({members.length}/12)</h2>
        <ul className="member-list">
          {members.map((member) => (
            <li key={member.user_id} className="member-row">
              <span>
                {memberName(member)}
                {member.role === "owner" && <em className="chip">owner</em>}
              </span>
              {isOwner && member.user_id !== session.user.id && (
                <span className="row">
                  <button
                    type="button"
                    className="danger"
                    disabled={busy}
                    onClick={() => void removeMember(member)}
                  >
                    Remove
                  </button>
                  <button type="button" disabled={busy} onClick={() => void makeOwner(member)}>
                    Make owner
                  </button>
                </span>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2>Activity</h2>
        {activity.length === 0 ? (
          <p>Nothing yet — joins, leaves and handovers show up here.</p>
        ) : (
          <ul className="activity-list">
            {activity.map((entry) => (
              <li key={entry.id} className="activity-item">
                <strong>{entry.profiles?.display_name ?? "Someone"}</strong>{" "}
                {activityText(entry, members)}{" "}
                <time className="muted">{new Date(entry.created_at).toLocaleDateString()}</time>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card stack">
        <h2>Invite people</h2>
        <div className="row">
          <input
            type="text"
            readOnly
            value={inviteLink ?? "…"}
            onFocus={(event) => event.target.select()}
          />
          <button type="button" onClick={() => void copyInviteLink()}>
            {copied ? "Copied!" : "Copy link"}
          </button>
        </div>
        <p className="muted">
          Anyone with this link can join until the group fills up. Rotating kills the current link
          on the spot.
        </p>
        {isOwner && (
          <div className="row">
            <button type="button" className="danger" disabled={busy} onClick={() => void rotateCode()}>
              Rotate code
            </button>
            <span className="muted">
              Current code: <code className="chip">{group.invite_code}</code>
            </span>
          </div>
        )}
      </section>

      <section>
        {isOwner ? (
          <p className="muted">
            You own this group. Hand it over (Make owner, next to a member) before you can leave.
          </p>
        ) : (
          <button type="button" className="danger" disabled={busy} onClick={() => void leaveGroup()}>
            Leave group
          </button>
        )}
      </section>
    </main>
  );
}
