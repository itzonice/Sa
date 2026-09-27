import { z } from "zod";
import { MAX_PLANNED_MINUTES, MIN_PLANNED_MINUTES } from "./countdown";
import { MAX_CODE_LENGTH, MIN_CODE_LENGTH } from "./session-code";
import { MAX_RECAP_NOTE_LENGTH } from "./recap";
import { NUDGE_LIMIT_PER_SESSION } from "./presence";

/**
 * Item 19: the Zod schemas for everything that crosses the network.
 *
 * The same schema validates on the way in (the route handler) and on the way out
 * (the typed client), so a migration that adds a nullable column fails loudly at
 * the boundary instead of rendering `undefined` minutes in a recap.
 *
 * Bounds here mirror the database constraints in 0008 on purpose: the database
 * stays authoritative, these just turn a violation into a field-level message
 * instead of a 409.
 */

export const uuidSchema = z.string().uuid();

export const liveSessionStatusSchema = z.enum(["planned", "active", "done", "missed"]);

export const courseNameSchema = z
  .string()
  .trim()
  .min(1, "Pick a course.")
  .max(80, "Keep the course name under 80 characters.");

export const plannedMinutesSchema = z
  .number()
  .int("Whole minutes only.")
  .min(MIN_PLANNED_MINUTES, `At least ${MIN_PLANNED_MINUTES} minutes.`)
  .max(MAX_PLANNED_MINUTES, `At most ${MAX_PLANNED_MINUTES} minutes.`);

export const joinCodeSchema = z
  .string()
  .trim()
  .transform((value) => value.toUpperCase())
  .pipe(
    z
      .string()
      .min(MIN_CODE_LENGTH, `Codes are at least ${MIN_CODE_LENGTH} characters.`)
      .max(MAX_CODE_LENGTH, `Codes are at most ${MAX_CODE_LENGTH} characters.`)
      .regex(/^[A-Z0-9]+$/, "Letters and numbers only."),
  );

export const recapNoteSchema = z
  .string()
  .trim()
  .max(MAX_RECAP_NOTE_LENGTH, `One line, ${MAX_RECAP_NOTE_LENGTH} characters max.`)
  .transform((value) => (value.length === 0 ? null : value));

/** Ending a session is allowed to log zero minutes: "missed" means missed. */
const actualMinutesSchema = z
  .number()
  .int("Whole minutes only.")
  .min(0, "Minutes cannot be negative.")
  .max(MAX_PLANNED_MINUTES * 3, "That is longer than a day of studying.");

// --- request bodies ---------------------------------------------------------

/** Item 11/20: the client generates the id, which makes the write idempotent. */
export const startLiveSessionBodySchema = z.object({
  sessionId: uuidSchema,
  code: joinCodeSchema,
  courseName: courseNameSchema,
  plannedMinutes: plannedMinutesSchema,
});
export type StartLiveSessionBody = z.infer<typeof startLiveSessionBodySchema>;

export const joinLiveSessionBodySchema = z.object({
  participantId: uuidSchema,
  sessionId: uuidSchema,
  code: joinCodeSchema,
});
export type JoinLiveSessionBody = z.infer<typeof joinLiveSessionBodySchema>;

export const leaveLiveSessionBodySchema = z.object({
  sessionId: uuidSchema,
});

export const endLiveSessionBodySchema = z.object({
  sessionId: uuidSchema,
  status: z.enum(["done", "missed"], { message: "A session ends as done or missed." }),
  /** Omit to let the server derive it from its own clock. */
  actualMinutes: actualMinutesSchema.optional(),
  note: recapNoteSchema.optional(),
});
export type EndLiveSessionBody = z.infer<typeof endLiveSessionBodySchema>;

export const nudgeBodySchema = z.object({
  nudgeId: uuidSchema,
  sessionId: uuidSchema,
  targetUserId: uuidSchema,
});
export type NudgeBody = z.infer<typeof nudgeBodySchema>;

export const liveSessionParamsSchema = z.object({ sessionId: uuidSchema });

export const codeQuerySchema = z.object({ code: joinCodeSchema });

// --- rows returned by the RPCs ---------------------------------------------

export const liveSessionRowSchema = z.object({
  id: z.string(),
  code: z.string(),
  owner_id: z.string(),
  course_name: z.string(),
  planned_minutes: z.number(),
  started_at: z.string().nullable(),
  ended_at: z.string().nullable(),
  status: liveSessionStatusSchema,
  ended_reason: z.string().nullable(),
  actual_minutes: z.number().nullable(),
  recap_note: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type LiveSessionRow = z.infer<typeof liveSessionRowSchema>;

export const liveParticipantRowSchema = z.object({
  id: z.string(),
  session_id: z.string(),
  user_id: z.string(),
  role: z.enum(["host", "buddy"]),
  joined_at: z.string(),
  left_at: z.string().nullable(),
  last_active_at: z.string(),
});
export type LiveParticipantRow = z.infer<typeof liveParticipantRowSchema>;

export const liveNudgeRowSchema = z.object({
  id: z.string(),
  session_id: z.string(),
  from_user_id: z.string(),
  to_user_id: z.string(),
  sent_at: z.string(),
});
export type LiveNudgeRow = z.infer<typeof liveNudgeRowSchema>;

export const profilePeerSchema = z.object({
  id: z.string(),
  display_name: z.string().nullable(),
  avatar_url: z.string().nullable(),
  timezone: z.string(),
});
export type ProfilePeer = z.infer<typeof profilePeerSchema>;

export const inviteCardSchema = z.object({
  sessionId: z.string(),
  code: z.string(),
  courseName: z.string(),
  plannedMinutes: z.number(),
  startedAt: z.string().nullable(),
  status: liveSessionStatusSchema,
  hostDisplayName: z.string().nullable(),
  spotsLeft: z.number(),
});
export type InviteCard = z.infer<typeof inviteCardSchema>;

export const nudgeQuotaSchema = z.object({
  sent: z.number().int().min(0),
  remaining: z.number().int().min(0).max(NUDGE_LIMIT_PER_SESSION),
});
export type NudgeQuota = z.infer<typeof nudgeQuotaSchema>;
