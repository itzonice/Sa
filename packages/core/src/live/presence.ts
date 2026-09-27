/**
 * Item 13 (presence) and item 17 (nudge eligibility).
 *
 * Presence has two sources and the roster is their union:
 *   - Supabase Realtime presence, which is ephemeral (it disappears the moment a
 *     socket drops) and carries whatever display name the client broadcast;
 *   - `live_session_participants.last_active_at`, which is durable and is what
 *     the server-side guard trusts.
 *
 * The host has no participant row, so callers seed the roster with a synthetic
 * host entry derived from the session row.
 */

export const IDLE_AFTER_MS = 10 * 60_000;
export const NUDGE_LIMIT_PER_SESSION = 3;

export type PresenceRole = "host" | "buddy";

export type PresenceEntry = {
  userId: string;
  displayName: string;
  role: PresenceRole;
  /** Server-clock ms of the last known activity. */
  lastActiveAtMs: number;
  /** False once Realtime reports the socket gone. */
  online: boolean;
};

export type Roster = {
  entries: PresenceEntry[];
  /** Server-clock ms the roster was computed against. */
  asOfMs: number;
};

export type NudgeReason =
  "ok" | "self" | "offline" | "not-idle-enough" | "limit-reached" | "not-in-session";

export type NudgeState = {
  targetId: string;
  targetName: string;
  idleForMs: number;
  sent: number;
  remaining: number;
  eligible: boolean;
  reason: NudgeReason;
};

export function mergePresence(
  realtime: readonly PresenceEntry[],
  persisted: readonly PresenceEntry[],
): PresenceEntry[] {
  const byUser = new Map<string, PresenceEntry>();

  for (const entry of persisted) {
    byUser.set(entry.userId, { ...entry, online: false });
  }

  for (const entry of realtime) {
    const previous = byUser.get(entry.userId);
    byUser.set(entry.userId, {
      ...previous,
      ...entry,
      // Realtime is the stronger signal for liveness, but it can lag a heartbeat,
      // so it must never move lastActiveAt backwards.
      lastActiveAtMs: Math.max(entry.lastActiveAtMs, previous?.lastActiveAtMs ?? 0),
      online: true,
    });
  }

  return [...byUser.values()].sort((a, b) => a.lastActiveAtMs - b.lastActiveAtMs);
}

export function idleForMs(entry: PresenceEntry, serverNowMs: number): number {
  return Math.max(0, serverNowMs - entry.lastActiveAtMs);
}

export function isIdle(entry: PresenceEntry, serverNowMs: number): boolean {
  return idleForMs(entry, serverNowMs) >= IDLE_AFTER_MS;
}

/** Roster label, e.g. "here" or "here - 4 min ago". */
export function describePresence(entry: PresenceEntry, serverNowMs: number): string {
  if (!entry.online) return "away";
  const idle = idleForMs(entry, serverNowMs);
  if (idle < 60_000) return "here";
  return `here - ${Math.floor(idle / 60_000)} min ago`;
}

/**
 * Whether a one-tap nudge is allowed right now, and why not if it is not.
 *
 * The database enforces the same rules (three per session, target must be in the
 * session). This exists so the button is disabled with a reason, instead of
 * letting the user tap their way into a 400.
 */
export function evaluateNudge(input: {
  viewerId: string;
  target: PresenceEntry | null;
  sentCount: number;
  serverNowMs: number;
}): NudgeState {
  const base: NudgeState = {
    targetId: input.target?.userId ?? "",
    targetName: input.target?.displayName ?? "buddy",
    idleForMs: input.target ? idleForMs(input.target, input.serverNowMs) : 0,
    sent: input.sentCount,
    remaining: Math.max(0, NUDGE_LIMIT_PER_SESSION - input.sentCount),
    eligible: false,
    reason: "not-in-session",
  };

  if (!input.target) return base;
  if (input.target.userId === input.viewerId) return { ...base, reason: "self" };
  if (base.remaining === 0) return { ...base, reason: "limit-reached" };
  if (!input.target.online) return { ...base, reason: "offline" };
  if (base.idleForMs < IDLE_AFTER_MS) return { ...base, reason: "not-idle-enough" };

  return { ...base, eligible: true, reason: "ok" };
}

/** The tooltip or helper line under a disabled nudge button. */
export function nudgeDisabledReason(state: NudgeState): string | null {
  switch (state.reason) {
    case "ok":
      return null;
    case "self":
      return "You cannot nudge yourself.";
    case "offline":
      return "They are not connected right now.";
    case "not-idle-enough":
      return `Nudge unlocks after ${Math.round(IDLE_AFTER_MS / 60_000)} minutes away.`;
    case "limit-reached":
      return "That is your three nudges for this session.";
    case "not-in-session":
      return "Nobody else is here yet.";
  }
}
