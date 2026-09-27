-- Items 8 & 11: core tables and check constraints.
-- Item 31: letter-grade scale per course.

create type public.assignment_status as enum ('not_started', 'in_progress', 'submitted', 'graded');

create table public.courses (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles (id) on delete cascade,
  title text not null check (length(btrim(title)) between 1 and 200),
  subject text,
  term_start date,
  term_end date,
  archived_at timestamptz,
  letter_scale jsonb, -- item 31: custom scale, e.g. [{"min":93,"letter":"A"}, ...]; null = default scale
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint courses_term_order check (term_start is null or term_end is null or term_start <= term_end)
);

create index courses_owner_idx on public.courses (owner_id)
  where archived_at is null;

create table public.grade_categories (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references public.courses (id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 100),
  weight numeric(5, 2) not null check (weight >= 0 and weight <= 100), -- item 11
  drop_lowest_n integer not null default 0 check (drop_lowest_n >= 0), -- item 31
  created_at timestamptz not null default now()
);

create index grade_categories_course_idx on public.grade_categories (course_id);

create table public.assignments (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references public.courses (id) on delete cascade,
  category_id uuid references public.grade_categories (id) on delete set null, -- nullable by design
  title text not null check (length(btrim(title)) between 1 and 300),
  description text,
  due_at timestamptz not null,
  status public.assignment_status not null default 'not_started',
  score numeric(6, 2) check (score is null or score >= 0), -- item 11: no upper bound => extra credit allowed
  max_score numeric(6, 2) not null default 100 check (max_score > 0),
  is_card_task boolean not null default false, -- item 38: auto-generated "make cards" tasks
  confidence jsonb not null default '{}'::jsonb, -- item 24: {inferred_date,inferred_year,expanded_recurring}
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index assignments_course_due_idx on public.assignments (course_id, due_at);
create index assignments_owner_due_idx on public.assignments (course_id, status, due_at);

create table public.study_sessions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles (id) on delete cascade,
  course_id uuid not null references public.courses (id) on delete cascade,
  assignment_id uuid references public.assignments (id) on delete set null,
  started_at timestamptz not null,
  ended_at timestamptz not null,
  minutes integer not null check (minutes > 0), -- item 11: positive durations
  notes text,
  created_at timestamptz not null default now(),
  constraint study_sessions_time_order check (ended_at > started_at)
);

create index study_sessions_owner_idx on public.study_sessions (owner_id, started_at);

-- Item 12: session must belong to the same course as its linked assignment.
create or replace function public.check_session_course_match()
returns trigger
language plpgsql
as $$
declare
  assignment_course uuid;
begin
  if new.assignment_id is null then
    return new;
  end if;

  select a.course_id into assignment_course
  from public.assignments a
  where a.id = new.assignment_id;

  if assignment_course is null then
    raise exception 'assignment % does not exist', new.assignment_id;
  end if;

  if assignment_course <> new.course_id then
    raise exception 'study_sessions.course_id % must match the assignment''s course %', new.course_id, assignment_course;
  end if;

  return new;
end;
$$;

create trigger study_sessions_course_match
  before insert or update on public.study_sessions
  for each row execute function public.check_session_course_match();

-- Keep updated_at fresh.
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger courses_touch_updated_at before update on public.courses
  for each row execute function public.touch_updated_at();
create trigger assignments_touch_updated_at before update on public.assignments
  for each row execute function public.touch_updated_at();
