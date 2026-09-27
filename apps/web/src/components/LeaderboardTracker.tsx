"use client";

import { useEffect } from "react";
import { track, EVENTS } from "@/lib/analytics";

interface LeaderboardTrackerProps {
  groupId: string;
}

export default function LeaderboardTracker({ groupId }: LeaderboardTrackerProps) {
  useEffect(() => {
    track(EVENTS.leaderboard_viewed, { groupId });
  }, [groupId]);

  return null; // This component doesn't render anything visible
}
