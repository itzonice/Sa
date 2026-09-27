/**
 * Items 34, 35, 36: study block scheduler, nightly re-ranker, exam review plans.
 * Pure functions; the edge function nightly job persists their output.
 */

import { computePriority } from "../priority";

export type SchedulableTask = {
  assignmentId: string;
  courseId: string;
  title: string;
  dueAt: string; // ISO
  gradeShare: number;
  status: "not_started" | "in_progress" | "submitted" | "graded";
  minutesRemaining: number;
  priorityBoost?: number;
};

export type PlannedBlock = {
  assignmentId: string;
  courseId: string;
  startAt: string; // ISO
  endAt: string; // ISO
  minutes: number;
};

export type SchedulerInput = {
  tasks: SchedulableTask[];
  /** Per local date (ISO yyyy-mm-dd) available study minutes. */
  availability: Record<string, number>;
  timezone: string; // informational; inputs are already local ISO strings
  now: string; // ISO instant
  /** Local date (yyyy-mm-dd) to start scheduling from. */
  startDay: string;
};

export type SchedulerOutput = {
  blocks: PlannedBlock[];
  /** Local dates whose demand exceeds availability (item 35: overloaded flag). */
  overloadedDays: string[];
  unscheduled: { assignmentId: string; reason: string }[];
};

const BLOCK_MINUTES = 45;

function localDayOf(iso: string): string {
  return iso.slice(0, 10);
}

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function dayDiff(a: string, b: string): number {
  return Math.round(
    (new Date(`${a}T12:00:00Z`).getTime() - new Date(`${b}T12:00:00Z`).getTime()) / 86_400_000,
  );
}

/**
 * Item 34: allocate study blocks backward from due dates, spreading exam prep
 * across the days between now and the due date.
 */
export function scheduleStudyBlocks(input: SchedulerInput): SchedulerOutput {
  const tasks = input.tasks
    .filter((t) => t.status === "not_started" || t.status === "in_progress")
    .sort((a, b) => {
      const pa = computePriority({
        gradeShare: a.gradeShare,
        daysUntilDue: dayDiff(localDayOf(a.dueAt), input.startDay),
        minutesRemaining: a.minutesRemaining,
        status: a.status,
        boost: a.priorityBoost,
      });
      const pb = computePriority({
        gradeShare: b.gradeShare,
        daysUntilDue: dayDiff(localDayOf(b.dueAt), input.startDay),
        minutesRemaining: b.minutesRemaining,
        status: b.status,
        boost: b.priorityBoost,
      });
      return pb.score - pa.score;
    });

  const dayQueue = Object.keys(input.availability)
    .filter((day) => day >= input.startDay)
    .sort();
  const remaining: Record<string, number> = { ...input.availability };
  const demand: Record<string, number> = {};

  const blocks: PlannedBlock[] = [];
  const unscheduled: { assignmentId: string; reason: string }[] = [];

  for (const task of tasks) {
    let minutes = task.minutesRemaining;
    const dueDay = localDayOf(task.dueAt);

    // Candidate days: between startDay and dueDay (never past the due date, item 35).
    const candidates = dayQueue.filter((d) => d < dueDay); // strictly before due day
    const daysSpan = Math.max(candidates.length, 1);

    // Spread: chunk the work across up to N days (exam prep spreads out).
    const perDayTarget = Math.ceil(minutes / Math.min(daysSpan, 5));

    for (const day of candidates) {
      if (minutes <= 0) break;
      const take = Math.min(remaining[day] ?? 0, perDayTarget, minutes, BLOCK_MINUTES * 2);
      if (take < 15) continue; // fragment too small
      const startHour = 16; // after class heuristic
      const startAt = `${day}T${String(startHour).padStart(2, "0")}:00:00`;
      const endAt = addMinutesLocal(startAt, take);
      blocks.push({
        assignmentId: task.assignmentId,
        courseId: task.courseId,
        startAt,
        endAt,
        minutes: take,
      });
      remaining[day] = (remaining[day] ?? 0) - take;
      demand[day] = (demand[day] ?? 0) + take;
      minutes -= take;
    }

    if (minutes > 0) {
      unscheduled.push({
        assignmentId: task.assignmentId,
        reason:
          candidates.length === 0
            ? "due before scheduling horizon"
            : `no availability before due date (${minutes} min short)`,
      });
    }
  }

  // Item 35: flag overloaded days — demand that ate all availability.
  const overloadedDays = Object.keys(remaining).filter(
    (day) =>
      (input.availability[day] ?? 0) > 0 && (remaining[day] ?? 0) === 0 && (demand[day] ?? 0) > 0,
  );

  return { blocks, overloadedDays, unscheduled };
}

function addMinutesLocal(localIso: string, minutes: number): string {
  const [datePart, timePart] = localIso.split("T");
  const [h, m] = (timePart ?? "00:00").split(":").map(Number);
  const total = (h ?? 0) * 60 + (m ?? 0) + minutes;
  const hh = String(Math.floor(total / 60) % 24).padStart(2, "0");
  const mm = String(total % 60).padStart(2, "0");
  return `${datePart}T${hh}:${mm}:00`;
}

/**
 * Item 35: nightly job logic — mark missed blocks, re-rank, reschedule.
 * Returns the persisted actions; the caller (edge function / cron) executes them.
 */
export type NightlyReport = {
  missedBlockIds: string[];
  rescheduled: PlannedBlock[];
  overloadedDays: string[];
};

export function planNightly(
  now: string,
  blocks: {
    id: string;
    startAt: string;
    endAt: string;
    status: "planned" | "done" | "missed";
    assignmentId: string | null;
  }[],
  tasks: SchedulableTask[],
  availability: Record<string, number>,
  startDay: string,
): NightlyReport {
  // 1) Mark missed: planned blocks that ended before now.
  const missedBlockIds = blocks
    .filter((b) => b.status === "planned" && b.endAt < now)
    .map((b) => b.id);

  // 2) Remaining planned minutes per task (blocks still upcoming, not done).
  const doneMinutes: Record<string, number> = {};
  for (const b of blocks) {
    if (b.status === "done" && b.assignmentId) {
      doneMinutes[b.assignmentId] = (doneMinutes[b.assignmentId] ?? 0) + 1; // count blocks, approximate
    }
  }

  // 3) Reschedule tasks whose work is still outstanding.
  const outstanding = tasks
    .map((t) => ({
      ...t,
      minutesRemaining: Math.max(t.minutesRemaining - (doneMinutes[t.assignmentId] ?? 0) * 45, 0),
    }))
    .filter((t) => t.minutesRemaining > 0 && t.status !== "graded");

  const sched = scheduleStudyBlocks({
    tasks: outstanding,
    availability,
    timezone: "UTC",
    now,
    startDay,
  });

  return {
    missedBlockIds,
    rescheduled: sched.blocks,
    overloadedDays: sched.overloadedDays,
  };
}

/**
 * Item 36: exam review-plan generator — sessions 7, 3, and 1 days before each exam.
 */
export type ExamInfo = {
  assignmentId: string;
  courseId: string;
  title: string;
  dueAt: string; // ISO
  minutesPerSession?: number;
};

export function generateReviewPlan(exams: ExamInfo[], now: string): PlannedBlock[] {
  const out: PlannedBlock[] = [];
  for (const exam of exams) {
    const dueDay = localDayOf(exam.dueAt);
    const today = localDayOf(now);
    for (const offset of [7, 3, 1]) {
      const day = addDays(dueDay, -offset);
      if (day < today) continue; // in the past — skip, never schedule past dates
      const startAt = `${day}T17:00:00`;
      const minutes = exam.minutesPerSession ?? 90;
      out.push({
        assignmentId: exam.assignmentId,
        courseId: exam.courseId,
        startAt,
        endAt: addMinutesLocal(startAt, minutes),
        minutes,
      });
    }
  }
  return out;
}
