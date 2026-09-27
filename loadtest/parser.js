/**
 * Item 42: k6 load test for the upload-syllabus edge function.
 * Run: k6 run -e HOST=https://<project>.supabase.co -e ANON_KEY=... -e JWT=... loadtest/parser.js
 * Starts at 1 VU, ramps to 20, asserts p95 < 30s (LLM-bound) and error rate < 5%.
 */

import http from "k6/http";
import { check, sleep } from "k6";
import { Trend } from "k6/metrics";

const parseDuration = new Trend("parse_duration", true);

export const options = {
  scenarios: {
    parser: {
      executor: "ramping-vus",
      startVUs: 1,
      stages: [
        { duration: "30s", target: 5 },
        { duration: "1m", target: 10 },
        { duration: "1m", target: 20 },
        { duration: "30s", target: 0 },
      ],
    },
  },
  thresholds: {
    "parse_duration": ["p(95)<30000"],
    "checks": ["rate>0.95"],
  },
};

const HOST = __ENV.HOST || "http://127.0.0.1:54321";
const ANON_KEY = __ENV.ANON_KEY || "";
const JWT = __ENV.JWT || "";

const SAMPLE_TEXT = `
COURSE SYLLABUS — BIOL 101 Introduction to Biology
Instructor: Dr. Smith | Term: Jan 20 - May 8

GRADING:
Exams 60% (Midterm 30%, Final 30%)
Labs 25% (12 labs)
Homework 15%

SCHEDULE:
Midterm Exam: March 5
Final Exam: May 8, 9:00 AM
Lab reports due weekly on Fridays
Problem sets due every other Tuesday
`.trim();

export default function () {
  const res = http.post(
    `${HOST}/functions/v1/upload-syllabus`,
    JSON.stringify({
      source: { kind: "text", text: SAMPLE_TEXT },
      term_start: "2026-01-20",
      term_end: "2026-05-08",
    }),
    {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${JWT}`,
        apikey: ANON_KEY,
      },
      timeout: "60s",
    },
  );
  parseDuration.add(res.timings.duration);

  check(res, {
    "status is 2xx or 422 (parse refusal)": (r) =>
      (r.status >= 200 && r.status < 300) || r.status === 422,
  });
  sleep(1);
}
