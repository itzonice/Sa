/**
 * Item 11/14: countdown maths for the live session timer.
 *
 * The rule this file exists to enforce: elapsed time is never derived from the
 * local clock alone. Every participant renders
 * `serverNowAtSync + (Date.now() - syncedAtClient)`, so two phones with
 * disagreeing clocks still converge on the server's timeline as soon as they
 * resync, and the countdown they show never disagrees with the one the host
 * sees.
 */

export const MIN_PLANNED_MINUTES = 5;
export const MAX_PLANNED_MINUTES = 480;

export type TimerState = {
  /** Server-clock instant the session started, epoch ms. */
  startedAtMs: number;
  /** Server-clock instant of the last sync, epoch ms. */
  serverNowMs: number;
  /** Local `Date.now()` at the moment `serverNowMs` was received. */
  clientSyncedAtMs: number;
  plannedMinutes: number;
};

export type Countdown = {
  /** Milliseconds until the planned end. Never negative. */
  remainingMs: number;
  /** Fraction of the planned block elapsed, clamped to [0, 1]. */
  progress: number;
  /** The planned block ran out but nobody has ended the session yet. */
  overtime: boolean;
  /** Server-clock "now", corrected for local drift. */
  serverNowMs: number;
};

export function plannedDurationMs(plannedMinutes: number): number {
  return plannedMinutes * 60_000;
}

/**
 * Estimated current server time, in epoch ms.
 *
 * Between syncs we advance the last known server instant by the same amount our
 * own clock advanced. Drift is therefore bounded by the time since the last
 * sync, which is why callers resync on an interval rather than once.
 */
export function estimateServerNowMs(timer: TimerState, clientNowMs: number): number {
  return timer.serverNowMs + Math.max(0, clientNowMs - timer.clientSyncedAtMs);
}

export function computeCountdown(timer: TimerState, clientNowMs: number): Countdown {
  const serverNowMs = estimateServerNowMs(timer, clientNowMs);
  const totalMs = plannedDurationMs(timer.plannedMinutes);
  const elapsedMs = Math.max(0, serverNowMs - timer.startedAtMs);
  const remainingMs = Math.max(0, totalMs - elapsedMs);

  return {
    remainingMs,
    progress: totalMs <= 0 ? 1 : Math.min(1, Math.max(0, elapsedMs / totalMs)),
    overtime: elapsedMs > totalMs,
    serverNowMs,
  };
}

/** `MM:SS`, or `H:MM:SS` past an hour. Identical for host and buddies. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;

  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");

  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * How far this device's clock is from the server's, in ms. Positive means the
 * device is ahead. Surfaced in the UI when it gets large enough to matter.
 */
export function clockSkewMs(timer: TimerState, clientNowMs: number): number {
  return clientNowMs - estimateServerNowMs(timer, clientNowMs);
}

/** Beyond this, the countdown deserves a "check your clock" hint. */
export const CLOCK_SKEW_WARN_MS = 5_000;

/** Builds the timer state from an RPC payload, which is all ISO strings. */
export function timerStateFrom(input: {
  startedAt: string;
  plannedMinutes: number;
  serverNow: string;
  clientNowMs?: number;
}): TimerState {
  return {
    startedAtMs: Date.parse(input.startedAt),
    plannedMinutes: input.plannedMinutes,
    serverNowMs: Date.parse(input.serverNow),
    clientSyncedAtMs: input.clientNowMs ?? Date.now(),
  };
}
