-- Items 13, 14, 38, 41: study blocks, syllabus uploads, course meetings,
-- assignment resources, study cards.

create type public.study_block_status as enum ('planned', 'done', 'missed');

create table public.study_blocks (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles (id) on delete cascade,
  course_id uuid not null references public.courses (id) on delete cascade,
  assignment_id uuid references public.assignments (id) on delete cascade,
  start_at timestamptz not null,
  end_at timestamptz not null,
  status public.study_block_status not null default 'planned',
  source text not null default 'scheduler', -- 'scheduler' | 'user' | 'review_plan'
  created_at timestamptz not null default now(),
  constraint study_blocks_time_order check (end_at > start_at) -- item 11: positive durations
);

create index study_blocks_owner_start_idx on public.study_blocks (owner_id, start_at);
create index study_blocks_assignment_idx on public.study_blocks (assignment_id)
  where status = 'planned';

create type public.syllabus_upload_status as enum ('pending', 'parsing', 'parsed', 'committed', 'failed');

create table public.syllabus_uploads (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles (id) on delete cascade,
  storage_path text not null, -- path inside the private 'syllabi' bucket
  status public.syllabus_upload_status not null default 'pending',
  source_kind text not null default 'file' check (source_kind in ('file', 'text', 'url')),
  parse_result jsonb, -- raw structured parser output
  error text,
  prompt_version text not null, -- ties results to the exact prompt+schema version used
  created_at timestamptz not null default now()
);

create index syllabus_uploads_owner_idx on public.syllabus_uploads (owner_id, created_at);

create type public.dow as enum ('mon','tue','wed','thu','fri','sat','sun');

create table public.course_meetings (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references public.courses (id) on delete cascade,
  weekday public.dow not null, -- item 38
  start_time time not null,
  end_time time not null,
  constraint course_meetings_time_order check (end_time > start_time)
);

create index course_meetings_course_idx on public.course_meetings (course_id, weekday);

create table public.assignment_resources (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid not null references public.assignments (id) on delete cascade,
  course_id uuid not null references public.courses (id) on delete cascade, -- denormalized for RLS
  kind text not null check (kind in ('khan_academy', 'notebooklm', 'anki_deck', 'other')),
  url text not null check (url ~ '^https?://'),
  label text,
  created_at timestamptz not null default now()
);

create index assignment_resources_assignment_idx on public.assignment_resources (assignment_id);

create table public.study_cards (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles (id) on delete cascade,
  assignment_id uuid references public.assignments (id) on delete set null,
  course_id uuid not null references public.courses (id) on delete cascade,
  question text not null check (length(btrim(question)) between 1 and 1000),
  answer text not null check (length(btrim(answer)) between 1 and 2000),
  source_note text,
  tags text[] not null default '{}',
  is_quiz_item boolean not null default false, -- item 40: closed-note quiz items
  created_at timestamptz not null default now()
);

create index study_cards_owner_idx on public.study_cards (owner_id, course_id, created_at);
