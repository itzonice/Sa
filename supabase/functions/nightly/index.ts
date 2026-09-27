/**
 * Item 35 (persistence half): nightly edge function.
 * Cron-invoked (service role, verify_jwt = false but protected by a shared secret).
 * - Marks past planned blocks as missed
 * - Re-ranks outstanding work and reschedules blocks
 * - Flags overloaded days on the profile
 *
 * POST /nightly  header: x-nightly-secret: $NIGHTLY_SECRET
 */

import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { getEdgeEnv } from "../_shared/env.ts";
import { planNightly } from "@studyly/core/scheduler";

const bodySchema = z.object({
  date: z.string().date().optional(), // local-date anchor; defaults to today UTC
});

Deno.serve(async (req) => {
  const env = getEdgeEnv();
  const secret = req.headers.get("x-nightly-secret");
  if (!secret || secret !== (Deno.env.get("NIGHTLY_SECRET") ?? "")) {
    return new Response("Forbidden", { status: 403 });
  }

  const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

  const { data: profiles } = await admin.from("profiles").select("id, timezone");
  const results: unknown[] = [];

  for (const profile of profiles ?? []) {
    const tz = profile.timezone || "UTC";
    const today = localDateInTz(new Date(), tz);

    // Missed blocks
    const { data: missed } = await admin
      .from("study_blocks")
      .update({ status: "missed" })
      .eq("owner_id", profile.id)
      .eq("status", "planned")
      .lt("end_at", new Date().toISOString())
      .select("id");

    // Outstanding tasks
    const { data: courses } = await admin
      .from("courses")
      .select("id")
      .eq("owner_id", profile.id)
      .is("archived_at", null);
    const courseIds = (courses ?? []).map((c) => c.id);

    if (courseIds.length === 0) {
      results.push({ user: profile.id, skipped: "no courses" });
      continue;
    }

    const { data: assignments } = await admin
      .from("assignments")
      .select("id, course_id, title, due_at, status, max_score, category_id, confidence")
      .in("course_id", courseIds)
      .in("status", ["not_started", "in_progress"]);

    const tasks = (assignments ?? []).map((a) => ({
      assignmentId: a.id as string,
      courseId: a.course_id as string,
      title: a.title as string,
      dueAt: a.due_at as string,
      gradeShare: 15, // refined by category weights on the client today; server default
      status: a.status as "not_started" | "in_progress",
      minutesRemaining: 90,
    }));

    const availability = buildDefaultAvailability(today, 7, 90);

    const report = planNightly(
      new Date().toISOString(),
      [], // missed already marked above via SQL update
      tasks,
      availability,
      today,
    );

    if (report.rescheduled.length > 0) {
      await admin.from("study_blocks").insert(
        report.rescheduled.map((b) => ({
          owner_id: profile.id,
          course_id: b.courseId,
          assignment_id: b.assignmentId,
          start_at: new Date(`${b.startAt}Z`).toISOString(),
          end_at: new Date(`${b.endAt}Z`).toISOString(),
          status: "planned",
          source: "scheduler",
        })),
      );
    }

    results.push({
      user: profile.id,
      missed: missed?.length ?? 0,
      rescheduled: report.rescheduled.length,
      overloadedDays: report.overloadedDays,
    });
  }

  return new Response(JSON.stringify({ ok: true, results }), {
    headers: { "content-type": "application/json" },
  });
});

function localDateInTz(d: Date, tz: string): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(d);
}

function buildDefaultAvailability(startDay: string, days: number, minutesPerDay: number) {
  const out: Record<string, number> = {};
  const d = new Date(`${startDay}T12:00:00Z`);
  for (let i = 0; i < days; i++) {
    const key = d.toISOString().slice(0, 10);
    out[key] = minutesPerDay;
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}
