import { type NextRequest, NextResponse } from "next/server";
import { requireUser, requireProfile } from "@/lib/auth";
import { getSupabaseServer } from "@/lib/supabase-server";
import { enforceRateLimit } from "@/lib/rate-limit";
import { AppError } from "@/lib/http/errors";
import { log } from "@studyly/core/analytics";

export async function POST(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const profile = await requireProfile(request);

    enforceRateLimit(user.id, "shareCard");

    const { kind, payload } = await request.json();

    if (!kind || !payload) {
      throw new AppError("bad_request", "Missing kind or payload.");
    }

    // Generate a 128-bit unguessable token (UUID v4 without dashes)
    const token = crypto.randomUUID().replace(/-/g, "");

    const supabase = getSupabaseServer();
    const { data, error } = await supabase
      .from("share_cards")
      .insert({
        user_id: user.id,
        token,
        kind,
        payload: {
          ...payload,
          display_name: profile.display_name, // Add display name to payload
          share_task_titles: profile.share_task_titles, // Add username toggle setting
        },
      })
      .select("token")
      .single();

    if (error) {
      throw new AppError("internal", "Failed to create share card.");
    }

    return NextResponse.json({ url: `/s/${data.token}` });
  } catch (error) {
    if (error instanceof AppError) {
      log.error(`API Error: ${error.message}`, { error });
      return new NextResponse(error.message, { status: error.status });
    }
    log.error(`Unexpected API Error: ${error}`, { error });
    return new NextResponse("Internal Server Error", { status: 500 });
  }
}
