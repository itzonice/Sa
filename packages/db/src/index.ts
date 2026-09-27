export * from "./database.types";

/** Hand-written row types (kept in sync manually until types are generated). */
export type PlanTier = "free" | "pro";
export type AssignmentStatus = "not_started" | "in_progress" | "submitted" | "graded";
export type StudyBlockStatus = "planned" | "done" | "missed";
export type SyllabusUploadStatus = "pending" | "parsing" | "parsed" | "committed" | "failed";

export type Profile = {
  id: string;
  timezone: string;
  school: string | null;
  display_name: string | null;
  /**
   * Public handle: 3-20 characters of `[a-z0-9_]`, unique case-insensitively.
   * Derived from the email local part at signup -- the address itself is never
   * stored here. Write it through the `set_username` RPC, not a direct update.
   */
  username: string;
  /**
   * Storage key in the private `avatars` bucket, not a URL. Render it via a
   * short-lived signed URL; never put it straight in an `img src`.
   */
  avatar_path: string | null;
  /** Superseded by `avatar_path`; still selected by the web layer. */
  avatar_url: string | null;
  plan_tier: PlanTier;
  /** Item 16: consecutive days with a completed live session, grace day included. */
  streak_current: number;
  streak_longest: number;
  /** Item 16: calendar day (in `timezone`) of the last completed session. */
  streak_last_day: string | null;
  created_at: string;
  updated_at: string;
};

export type Course = {
  id: string;
  owner_id: string;
  title: string;
  term_start: string | null;
  term_end: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

export type GradeCategory = {
  id: string;
  course_id: string;
  name: string;
  weight: number;
  drop_lowest_n: number;
  created_at: string;
};

export type Assignment = {
  id: string;
  course_id: string;
  category_id: string | null;
  title: string;
  due_at: string;
  status: AssignmentStatus;
  score: number | null;
  max_score: number;
  weight_share: number | null;
  priority_boost: number | null;
  created_at: string;
  updated_at: string;
};

export type StudySession = {
  id: string;
  owner_id: string;
  course_id: string;
  assignment_id: string | null;
  started_at: string;
  ended_at: string;
  minutes: number;
  notes: string | null;
  created_at: string;
};

export type StudyBlock = {
  id: string;
  owner_id: string;
  course_id: string;
  assignment_id: string | null;
  start_at: string;
  end_at: string;
  status: StudyBlockStatus;
  created_at: string;
};

export type SyllabusUpload = {
  id: string;
  owner_id: string;
  course_id: string | null;
  storage_path: string;
  status: SyllabusUploadStatus;
  parse_result: unknown;
  error: string | null;
  prompt_version: string;
  created_at: string;
};

/**
 * Live co-study sessions (spec items 5-17).
 *
 * Distinct from `StudyBlock` (a scheduled slot) and `StudySession` (logged past
 * studying): this is a session that is running right now, with a countdown, a
 * share code and up to three buddies.
 */
export type LiveSessionStatus = "planned" | "active" | "done" | "missed";
export type LiveParticipantRole = "host" | "buddy";

export type LiveSession = {
  id: string;
  code: string;
  owner_id: string;
  course_name: string;
  planned_minutes: number;
  started_at: string | null;
  ended_at: string | null;
  status: LiveSessionStatus;
  ended_reason: "completed" | "missed" | null;
  actual_minutes: number | null;
  /** Item 18: private to the owner, never shared with buddies. */
  recap_note: string | null;
  created_at: string;
  updated_at: string;
};

export type LiveSessionParticipant = {
  id: string;
  session_id: string;
  user_id: string;
  role: LiveParticipantRole;
  joined_at: string;
  left_at: string | null;
  last_active_at: string;
};

export type LiveSessionNudge = {
  id: string;
  session_id: string;
  from_user_id: string;
  to_user_id: string;
  sent_at: string;
};

/**
 * G2: invite-only study groups.
 *
 * Reachable only by its members or by exact invite code -- there is no directory
 * query to write, by design.
 */
export type StudyGroupRole = "owner" | "member";

export type StudyGroup = {
  id: string;
  owner_id: string;
  name: string;
  /** Six canonical Crockford base32 characters: 0-9 and A-Z minus I, L, O, U. */
  invite_code: string;
  invite_code_rotated_at: string;
  created_at: string;
};

export type StudyGroupMember = {
  group_id: string;
  user_id: string;
  role: StudyGroupRole;
  joined_at: string;
};

/** What `study_group_from_invite_code` returns, and nothing more. */
export type StudyGroupPreview = {
  id: string;
  name: string;
  member_count: number;
  full: boolean;
};

/**
 * G3: the membership ledger behind a group's activity feed.
 *
 * Rows are written only by the invite-flow RPCs (redeem_invite_code,
 * leave_group, remove_member, rotate_invite_code, transfer_owner) and read
 * only by members -- the same reach as the roster it describes.
 */
export type StudyGroupActivityKind = "joined" | "left" | "removed" | "transferred" | "code_rotated";

export type StudyGroupActivity = {
  id: string;
  group_id: string;
  /** Null once the actor has deleted their account; the event itself remains. */
  actor_id: string | null;
  kind: StudyGroupActivityKind;
  /** 'removed' carries { user_id }; 'transferred' carries { to_user_id }. */
  detail: unknown;
  created_at: string;
};
