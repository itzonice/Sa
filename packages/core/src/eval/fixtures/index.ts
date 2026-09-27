/**
 * Item 27 part 2: tricky synthetic cases as inline fixtures (no API needed —
 * the harness scores postprocessing + matching logic against expected output).
 */

import type { ExpectedFixture } from "../harness";

export const syntheticFixtures: ExpectedFixture[] = [
  {
    name: "syn-relative-dates",
    timezone: "America/Chicago",
    term_start: "2026-01-20",
    term_end: "2026-05-08",
    categories: [
      { name: "Exams", weight: 60 },
      { name: "Homework", weight: 40 },
    ],
    assignments: [
      { title: "Quiz 1", due_date: "2026-01-30", category_name: "Homework" },
      { title: "Midterm", due_date: "2026-03-06", category_name: "Exams" },
    ],
  },
  {
    name: "syn-recurring-labs",
    timezone: "Europe/London",
    term_start: "2026-01-12",
    term_end: "2026-03-20",
    categories: [
      { name: "Labs", weight: 50 },
      { name: "Final", weight: 50 },
    ],
    assignments: [
      { title: "Lab 1", due_date: "2026-01-23", category_name: "Labs" },
      { title: "Lab 2", due_date: "2026-01-30", category_name: "Labs" },
      { title: "Lab 3", due_date: "2026-02-06", category_name: "Labs" },
      { title: "Final Exam", due_date: "2026-03-20", category_name: "Final" },
    ],
  },
  {
    name: "syn-no-times",
    timezone: "Asia/Tokyo",
    term_start: "2026-04-01",
    term_end: "2026-06-30",
    categories: [{ name: "Reports", weight: 100 }],
    assignments: [{ title: "Report 1", due_date: "2026-05-15", category_name: "Reports" }],
  },
  {
    name: "syn-weights-not-100",
    timezone: "UTC",
    term_start: "2026-01-10",
    term_end: "2026-04-30",
    categories: [
      { name: "Exams", weight: 45 },
      { name: "Essays", weight: 30 },
    ],
    assignments: [{ title: "Essay 1", due_date: "2026-02-20", category_name: "Essays" }],
  },
  {
    name: "syn-out-of-term",
    timezone: "America/New_York",
    term_start: "2026-01-20",
    term_end: "2026-05-08",
    categories: [{ name: "All", weight: 100 }],
    assignments: [{ title: "Summer reading quiz", due_date: "2026-07-01", category_name: "All" }],
  },
  {
    name: "syn-duplicate-entries",
    timezone: "UTC",
    term_start: "2026-01-10",
    term_end: "2026-05-01",
    categories: [{ name: "Quizzes", weight: 100 }],
    assignments: [
      { title: "Quiz 1", due_date: "2026-01-25", category_name: "Quizzes" },
      { title: "Quiz 1", due_date: "2026-01-25", category_name: "Quizzes" },
    ],
  },
  {
    name: "syn-fuzzy-category",
    timezone: "America/Denver",
    term_start: "2026-01-15",
    term_end: "2026-05-05",
    categories: [{ name: "Homework", weight: 100 }],
    assignments: [{ title: "PS1", due_date: "2026-01-30", category_name: "HOMEWORK" }],
  },
  {
    name: "syn-extra-credit",
    timezone: "UTC",
    term_start: "2026-01-10",
    term_end: "2026-05-01",
    categories: [{ name: "Exams", weight: 100 }],
    assignments: [{ title: "Exam 1", due_date: "2026-02-15", category_name: "Exams" }],
  },
  {
    name: "syn-year-inference",
    timezone: "Australia/Sydney",
    term_start: "2026-02-01",
    term_end: "2026-06-01",
    categories: [{ name: "Tasks", weight: 100 }],
    assignments: [{ title: "Task A", due_date: "2026-03-10", category_name: "Tasks" }],
  },
  {
    name: "syn-ambiguous-noon",
    timezone: "Pacific/Honolulu",
    term_start: "2026-01-05",
    term_end: "2026-04-25",
    categories: [{ name: "Discussion", weight: 100 }],
    assignments: [{ title: "Post 1", due_date: "2026-01-16", category_name: "Discussion" }],
  },
];
