import "server-only";

import { getRlsClientFor } from "./auth";
import { getSupabaseAdmin } from "./supabase-admin";
import { AVATAR_BUCKET, AVATAR_SIGNED_URL_TTL_SECONDS, isOwnAvatarPath } from "@studyly/core/identity";
import { unstable_noStore as noStore } from "next/cache";

/**
 * A co-participant as the UI may render them.
 *
 * There is deliberately no email here: profiles do not carry one (addresses
 * live in auth.users and G1 keeps them private), and the username is the only
 * public handle. `avatar_url` is a short-lived signed URL minted per request,
 * never a stored link.
 */
export type ActiveFriend = {
  id: string;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
};

export async function getActiveFriends(request: Request): Promise<ActiveFriend[]> {
  noStore(); // Opt out of Next.js data cache

  // The caller's own JWT, so every query below is evaluated under RLS: the
  // session ids returned are exactly the ones the caller belongs to.
  const { supabase, user } = await getRlsClientFor(request);

  // Find all active live sessions the current user is part of (as owner or participant)
  const { data: userSessionsData, error: userSessionsError } = await supabase
    .from("live_session_participants")
    .select("session_id")
    .eq("user_id", user.id)
    .is("left_at", null);

  if (userSessionsError) {
    console.error("Error fetching user sessions:", userSessionsError);
    return [];
  }

  const ownedSessions = await supabase
    .from("live_sessions")
    .select("id")
    .eq("owner_id", user.id)
    .eq("status", "active");

  if (ownedSessions.error) {
    console.error("Error fetching owned sessions:", ownedSessions.error);
    return [];
  }

  const sessionIds = [
    ...userSessionsData.map((s) => s.session_id),
    ...ownedSessions.data.map((s) => s.id),
  ];

  if (sessionIds.length === 0) {
    return [];
  }

  // Get all participants (including owners) for these active sessions
  const { data: participantsData, error: participantsError } = await supabase
    .from("live_session_participants")
    .select("user_id, live_sessions(owner_id)")
    .in("session_id", sessionIds)
    .is("left_at", null);

  if (participantsError) {
    console.error("Error fetching participants:", participantsError);
    return [];
  }

  const allFriendIds = new Set<string>();
  for (const participant of participantsData) {
    if (participant.user_id !== user.id) {
      allFriendIds.add(participant.user_id);
    }
    // A single-FK embed returns an object at runtime; supabase-js's inferred
    // types (no generated types yet) model it as an array, hence the cast.
    const ownerOfSession = (participant.live_sessions ?? null) as unknown as {
      owner_id: string;
    } | null;
    if (ownerOfSession && ownerOfSession.owner_id !== user.id) {
      allFriendIds.add(ownerOfSession.owner_id);
    }
  }

  // Also add owners of sessions where the current user is a participant
  const { data: otherOwnersData, error: otherOwnersError } = await supabase
    .from("live_sessions")
    .select("owner_id")
    .in("id", sessionIds)
    .neq("owner_id", user.id);

  if (otherOwnersError) {
    console.error("Error fetching other owners:", otherOwnersError);
    return [];
  }

  for (const owner of otherOwnersData) {
    allFriendIds.add(owner.owner_id);
  }

  if (allFriendIds.size === 0) {
    return [];
  }

  // Public identity fields only. There is no email column on profiles to
  // select — and that is the point (G1).
  const { data: friendsProfiles, error: profilesError } = await supabase
    .from("profiles")
    .select("id, username, display_name, avatar_path")
    .in("id", Array.from(allFriendIds));

  if (profilesError) {
    console.error("Error fetching friends profiles:", profilesError);
    return [];
  }

  // The caller's Storage policy only covers their own folder, so a friend's
  // avatar cannot be signed with the caller's token. These ids came from the
  // caller's own session rosters — the app's sharing relationship — so minting
  // a five-minute URL for exactly those avatars is the narrow path that keeps
  // the private bucket private while the roster stays renderable.
  const admin = getSupabaseAdmin();
  const friends: ActiveFriend[] = [];
  for (const profile of friendsProfiles) {
    let avatarUrl: string | null = null;
    if (profile.avatar_path && isOwnAvatarPath(profile.id, profile.avatar_path)) {
      const { data: signed } = await admin.storage
        .from(AVATAR_BUCKET)
        .createSignedUrl(profile.avatar_path, AVATAR_SIGNED_URL_TTL_SECONDS);
      avatarUrl = signed?.signedUrl ?? null;
    }
    friends.push({
      id: profile.id,
      username: profile.username,
      display_name: profile.display_name,
      avatar_url: avatarUrl,
    });
  }

  return friends;
}
