-- Studyly demo seed. Run with `pnpm db:seed` (after `pnpm db:reset`).
-- Safe to re-run: uses fixed UUIDs and ON CONFLICT DO NOTHING.

begin;

-- Demo auth user (the signup trigger would create the profile normally;
-- we seed auth.users directly, then upsert the profile with a timezone).
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  '00000000-0000-0000-0000-000000000000',
  '11111111-1111-1111-1111-111111111111',
  'authenticated',
  'authenticated',
  'demo@studyly.test',
  crypt('demo-password-123', gen_salt('bf')),
  now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{"timezone":"America/New_York","school":"State University"}'::jsonb,
  now(),
  now()
)
on conflict (id) do nothing;

insert into public.profiles (id, timezone, school, plan_tier)
values ('11111111-1111-1111-1111-111111111111', 'America/New_York', 'State University', 'free')
on conflict (id) do nothing;

-- 4 courses
insert into public.courses (id, owner_id, title, subject, term_start, term_end)
values
  ('aaaaaaa1-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'Biology 101', 'BIOL', current_date - 21, current_date + 60),
  ('aaaaaaa1-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'Calculus II', 'MATH', current_date - 21, current_date + 60),
  ('aaaaaaa1-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111', 'World History', 'HIST', current_date - 21, current_date + 60),
  ('aaaaaaa1-0000-0000-0000-000000000004', '11111111-1111-1111-1111-111111111111', 'Intro to Philosophy', 'PHIL', current_date - 21, current_date + 60)
on conflict (id) do nothing;

-- Grade categories (weights total 100 per course)
insert into public.grade_categories (id, course_id, name, weight) values
  ('bbbbbbb1-0000-0000-0000-000000000001', 'aaaaaaa1-0000-0000-0000-000000000001', 'Exams', 60),
  ('bbbbbbb1-0000-0000-0000-000000000002', 'aaaaaaa1-0000-0000-0000-000000000001', 'Labs', 25),
  ('bbbbbbb1-0000-0000-0000-000000000003', 'aaaaaaa1-0000-0000-0000-000000000001', 'Homework', 15),
  ('bbbbbbb1-0000-0000-0000-000000000004', 'aaaaaaa1-0000-0000-0000-000000000002', 'Exams', 70),
  ('bbbbbbb1-0000-0000-0000-000000000005', 'aaaaaaa1-0000-0000-0000-000000000002', 'Problem Sets', 30),
  ('bbbbbbb1-0000-0000-0000-000000000006', 'aaaaaaa1-0000-0000-0000-000000000003', 'Essays', 50),
  ('bbbbbbb1-0000-0000-0000-000000000007', 'aaaaaaa1-0000-0000-0000-000000000003', 'Participation', 20),
  ('bbbbbbb1-0000-0000-0000-000000000008', 'aaaaaaa1-0000-0000-0000-000000000003', 'Final Exam', 30),
  ('bbbbbbb1-0000-0000-0000-000000000009', 'aaaaaaa1-0000-0000-0000-000000000004', 'Papers', 60),
  ('bbbbbbb1-0000-0000-0000-00000000000a', 'aaaaaaa1-0000-0000-0000-000000000004', 'Quizzes', 40)
on conflict (id) do nothing;

-- Assignments: a mix of graded (with scores) and upcoming
insert into public.assignments (id, course_id, category_id, title, due_at, status, score, max_score) values
  -- Biology: exam done, labs partially done, homework ongoing
  ('ccccccc1-0000-0000-0000-000000000001', 'aaaaaaa1-0000-0000-0000-000000000001', 'bbbbbbb1-0000-0000-0000-000000000001', 'Midterm Exam', (current_date - 7)::timestamptz, 'graded', 78, 100),
  ('ccccccc1-0000-0000-0000-000000000002', 'aaaaaaa1-0000-0000-0000-000000000001', 'bbbbbbb1-0000-0000-0000-000000000002', 'Lab 1: Cell Structure', (current_date - 10)::timestamptz, 'graded', 95, 100),
  ('ccccccc1-0000-0000-0000-000000000003', 'aaaaaaa1-0000-0000-0000-000000000001', 'bbbbbbb1-0000-0000-0000-000000000002', 'Lab 2: Osmosis', (current_date - 3)::timestamptz, 'graded', 88, 100),
  ('ccccccc1-0000-0000-0000-000000000004', 'aaaaaaa1-0000-0000-0000-000000000001', 'bbbbbbb1-0000-0000-0000-000000000003', 'Problem Set 3', (current_date + 2)::timestamptz + interval '23 hours', 'not_started', null, 20),
  ('ccccccc1-0000-0000-0000-000000000005', 'aaaaaaa1-0000-0000-0000-000000000001', 'bbbbbbb1-0000-0000-0000-000000000001', 'Final Exam', (current_date + 45)::timestamptz, 'not_started', null, 100),
  -- Calculus: problem sets graded, exam upcoming
  ('ccccccc1-0000-0000-0000-000000000006', 'aaaaaaa1-0000-0000-0000-000000000002', 'bbbbbbb1-0000-0000-0000-000000000005', 'PS 1: Integration', (current_date - 14)::timestamptz, 'graded', 92, 100),
  ('ccccccc1-0000-0000-0000-000000000007', 'aaaaaaa1-0000-0000-0000-000000000002', 'bbbbbbb1-0000-0000-0000-000000000005', 'PS 2: Series', (current_date - 5)::timestamptz, 'graded', 61, 100),
  ('ccccccc1-0000-0000-0000-000000000008', 'aaaaaaa1-0000-0000-0000-000000000002', 'bbbbbbb1-0000-0000-0000-000000000004', 'Exam 2', (current_date + 5)::timestamptz, 'not_started', null, 100),
  ('ccccccc1-0000-0000-0000-000000000009', 'aaaaaaa1-0000-0000-0000-000000000002', 'bbbbbbb1-0000-0000-0000-000000000005', 'PS 3: Diff Eq', (current_date + 8)::timestamptz, 'not_started', null, 50),
  -- History: essay in progress
  ('ccccccc1-0000-0000-0000-00000000000a', 'aaaaaaa1-0000-0000-0000-000000000003', 'bbbbbbb1-0000-0000-0000-000000000006', 'Essay 1: Cold War', (current_date + 3)::timestamptz + interval '23 hours', 'in_progress', null, 100),
  ('ccccccc1-0000-0000-0000-00000000000b', 'aaaaaaa1-0000-0000-0000-000000000003', 'bbbbbbb1-0000-0000-0000-000000000008', 'Final Exam', (current_date + 50)::timestamptz, 'not_started', null, 100),
  -- Philosophy: quizzes graded
  ('ccccccc1-0000-0000-0000-00000000000c', 'aaaaaaa1-0000-0000-0000-000000000004', 'bbbbbbb1-0000-0000-0000-00000000000a', 'Quiz 1: Plato', (current_date - 12)::timestamptz, 'graded', 70, 100),
  ('ccccccc1-0000-0000-0000-00000000000d', 'aaaaaaa1-0000-0000-0000-000000000004', 'bbbbbbb1-0000-0000-0000-00000000000a', 'Quiz 2: Aristotle', (current_date - 2)::timestamptz, 'graded', 85, 100),
  ('ccccccc1-0000-0000-0000-00000000000e', 'aaaaaaa1-0000-0000-0000-000000000004', 'bbbbbbb1-0000-0000-0000-000000000009', 'Paper 1: Ethics', (current_date + 10)::timestamptz, 'not_started', null, 100)
on conflict (id) do nothing;

-- Study sessions over the past two weeks
insert into public.study_sessions (id, owner_id, course_id, assignment_id, started_at, ended_at, minutes) values
  ('ddddddd1-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'aaaaaaa1-0000-0000-0000-000000000001', 'ccccccc1-0000-0000-0000-000000000001', (current_date - 8)::timestamptz + interval '19 hours', (current_date - 8)::timestamptz + interval '20 hours 30 minutes', 90),
  ('ddddddd1-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'aaaaaaa1-0000-0000-0000-000000000001', 'ccccccc1-0000-0000-0000-000000000003', (current_date - 4)::timestamptz + interval '16 hours', (current_date - 4)::timestamptz + interval '17 hours', 60),
  ('ddddddd1-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111', 'aaaaaaa1-0000-0000-0000-000000000002', 'ccccccc1-0000-0000-0000-000000000007', (current_date - 6)::timestamptz + interval '18 hours', (current_date - 6)::timestamptz + interval '19 hours 45 minutes', 105),
  ('ddddddd1-0000-0000-0000-000000000004', '11111111-1111-1111-1111-111111111111', 'aaaaaaa1-0000-0000-0000-000000000003', 'ccccccc1-0000-0000-0000-00000000000a', (current_date - 1)::timestamptz + interval '15 hours', (current_date - 1)::timestamptz + interval '16 hours 15 minutes', 75),
  ('ddddddd1-0000-0000-0000-000000000005', '11111111-1111-1111-1111-111111111111', 'aaaaaaa1-0000-0000-0000-000000000004', null, (current_date)::timestamptz + interval '10 hours', (current_date)::timestamptz + interval '10 hours 45 minutes', 45)
on conflict (id) do nothing;

-- Study blocks: one done, one planned for tomorrow
insert into public.study_blocks (id, owner_id, course_id, assignment_id, start_at, end_at, status) values
  ('eeeeeee1-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'aaaaaaa1-0000-0000-0000-000000000002', 'ccccccc1-0000-0000-0000-000000000008', (current_date)::timestamptz + interval '19 hours', (current_date)::timestamptz + interval '20 hours 30 minutes', 'done'),
  ('eeeeeee1-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'aaaaaaa1-0000-0000-0000-000000000001', 'ccccccc1-0000-0000-0000-000000000004', (current_date + 1)::timestamptz + interval '17 hours', (current_date + 1)::timestamptz + interval '18 hours', 'planned')
on conflict (id) do nothing;

-- Course meetings (Mon/Wed/Fri classes)
insert into public.course_meetings (id, course_id, weekday, start_time, end_time) values
  ('fffffff1-0000-0000-0000-000000000001', 'aaaaaaa1-0000-0000-0000-000000000001', 1, '09:00', '09:50'),
  ('fffffff1-0000-0000-0000-000000000002', 'aaaaaaa1-0000-0000-0000-000000000001', 3, '09:00', '09:50'),
  ('fffffff1-0000-0000-0000-000000000003', 'aaaaaaa1-0000-0000-0000-000000000001', 5, '09:00', '09:50'),
  ('fffffff1-0000-0000-0000-000000000004', 'aaaaaaa1-0000-0000-0000-000000000002', 2, '11:00', '12:15'),
  ('fffffff1-0000-0000-0000-000000000005', 'aaaaaaa1-0000-0000-0000-000000000002', 4, '11:00', '12:15'),
  ('fffffff1-0000-0000-0000-000000000006', 'aaaaaaa1-0000-0000-0000-000000000003', 1, '14:00', '15:15'),
  ('fffffff1-0000-0000-0000-000000000007', 'aaaaaaa1-0000-0000-0000-000000000003', 3, '14:00', '15:15'),
  ('fffffff1-0000-0000-0000-000000000008', 'aaaaaaa1-0000-0000-0000-000000000004', 4, '13:00', '13:50')
on conflict (id) do nothing;

commit;
