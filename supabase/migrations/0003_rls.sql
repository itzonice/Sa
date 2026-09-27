-- Item 9: owner-only RLS. Child tables (grade_categories, assignments, course_meetings,
-- assignment_resources) inherit ownership from their parent course.

-- Reusable helper: is the current user the owner of this course row?
create or replace function public.is_course_owner(course uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.courses c
    where c.id = course and c.owner_id = auth.uid()
  );
$$;

alter table public.profiles enable row level security;
alter table public.courses enable row level security;
alter table public.grade_categories enable row level security;
alter table public.assignments enable row level security;
alter table public.study_sessions enable row level security;
alter table public.study_blocks enable row level security;
alter table public.syllabus_uploads enable row level security;
alter table public.course_meetings enable row level security;
alter table public.assignment_resources enable row level security;
alter table public.study_cards enable row level security;

create policy "profiles_select_own" on public.profiles
  for select using (id = auth.uid());
create policy "profiles_update_own" on public.profiles
  for update using (id = auth.uid()) with check (id = auth.uid());
-- Profile inserts happen in the signup trigger (security definer), so no insert policy.

create policy "courses_all_own" on public.courses
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create policy "grade_categories_all_own" on public.grade_categories
  for all using (public.is_course_owner(course_id)) with check (public.is_course_owner(course_id));

create policy "assignments_all_own" on public.assignments
  for all using (public.is_course_owner(course_id)) with check (public.is_course_owner(course_id));

create policy "study_sessions_all_own" on public.study_sessions
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create policy "study_blocks_all_own" on public.study_blocks
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create policy "syllabus_uploads_all_own" on public.syllabus_uploads
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create policy "course_meetings_all_own" on public.course_meetings
  for all using (public.is_course_owner(course_id)) with check (public.is_course_owner(course_id));

create policy "assignment_resources_all_own" on public.assignment_resources
  for all using (public.is_course_owner(course_id)) with check (public.is_course_owner(course_id));

create policy "study_cards_all_own" on public.study_cards
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

comment on function public.is_course_owner(uuid) is 'RLS helper: child tables check ownership through courses (item 9).';
