import { ImageResponse } from "next/og";
import { notFound } from "next/navigation";
import { getSupabaseAnon } from "@/lib/supabase-server";

export const runtime = "edge";

export default async function OpenGraphImage({
  params,
}: {
  params: { token: string };
}) {
  const supabase = getSupabaseAnon();

  const { data: shareCard, error } = await supabase
    .from("share_cards")
    .select("*")
    .eq("token", params.token)
    .single();

  if (error || !shareCard || new Date(shareCard.expires_at) < new Date()) {
    notFound();
  }

  const { kind, payload } = shareCard;
  const displayName = payload.display_name || "A StudyPulse User";
  const showUsername = payload.share_task_titles ?? false; // Default to false

  return new ImageResponse(
    (
      <div
        style={{
          height: "100%",
          width: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: "white",
          fontSize: 32,
          fontWeight: 600,
        }}
      >
        <div style={{ marginBottom: 20 }}>StudyPulse Share Card</div>
        {kind === "session" && (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
            <div style={{ fontSize: 24 }}>Study Session with</div>
            <div style={{ fontSize: 48, fontWeight: 700 }}>
              {payload.course_name || "a course"}
            </div>
            <div style={{ fontSize: 24, marginTop: 10 }}>
              for <span style={{ fontWeight: 700 }}>{payload.minutes} minutes</span>
            </div>
          </div>
        )}
        {kind === "streak" && (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
            <div style={{ fontSize: 24 }}>Study Streak of</div>
            <div style={{ fontSize: 48, fontWeight: 700 }}>
              {payload.streak_current} days
            </div>
          </div>
        )}
        <div style={{ marginTop: 20, fontSize: 20 }}>
          Created by: {showUsername ? displayName : "A StudyPulse User"}
        </div>
      </div>
    ),
    {
      width: 1200,
      height: 630,
    },
  );
}
