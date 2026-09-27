"use client";

import { useEffect } from "react";

type PostHogLike = {
  capture: (event: string, props?: Record<string, unknown>) => void;
};

let client: PostHogLike | null = null;

export const EVENTS = {
  signup: "signup",
  syllabus_parsed: "syllabus_parsed",
  course_committed: "course_committed",
  session_logged: "session_logged",
  group_created: "group_created",
  group_joined: "group_joined",
  leaderboard_viewed: "leaderboard_viewed",
  share_card_created: "share_card_created",
} as const;

export type AnalyticsEvent = keyof typeof EVENTS;

async function loadPostHog(): Promise<PostHogLike | null> {
  if (client) return client;
  try {
    const envModule = await import("@studyly/core/env");
    const env = envModule.getEnv();
    if (!env.POSTHOG_KEY) return null;
    const mod = await import("posthog-js");
    mod.default.init(env.POSTHOG_KEY, {
      api_host: env.POSTHOG_HOST ?? "https://us.i.posthog.com",
      capture_pageview: false,
    });
    client = mod.default as unknown as PostHogLike;
    return client;
  } catch {
    return null;
  }
}

export function track(event: AnalyticsEvent, props?: Record<string, unknown>) {
  void loadPostHog().then((ph) => {
    ph?.capture(EVENTS[event], props);
  });
}

export function AnalyticsProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    void loadPostHog();
  }, []);
  return <>{children}</>;
}
