-- Item 25: single-transaction commit of a parsed syllabus.
-- The parser (edge function) posts its validated output here via rpc;
-- Postgres inserts course + categories + assignments atomically.

create or replace function public.commit_parsed_syllabus(payload jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid := auth.uid();
  v_course_id uuid;
  v_cat record;
  v_assignment jsonb;
  v_category_id uuid;
  v_existing uuid;
begin
  if v_owner is null then
    raise exception 'not authenticated';
  end if;

  -- Validate the envelope shape up front (zod already validated it; SQL re-checks).
  if payload ? 'course_id' then
    -- Upsert mode: adding parsed items into an existing course we own.
    select c.id into v_existing from public.courses c where c.id = (payload ->> 'course_id')::uuid and c.owner_id = v_owner;
    if v_existing is null then
      raise exception 'course % not found or not owned by caller', payload ->> 'course_id';
    end if;
    v_course_id := v_existing;
  else
    insert into public.courses (owner_id, title, subject, term_start, term_end)
    values (
      v_owner,
      coalesce(payload ->> 'title', 'Untitled course'),
      nullif(payload ->> 'subject', ''),
      (payload ->> 'term_start')::date,
      (payload ->> 'term_end')::date
    )
    returning id into v_course_id;
  end if;

  -- Categories first (assignments reference them).
  for v_cat in
    select * from jsonb_to_recordset(coalesce(payload -> 'categories', '[]'::jsonb))
      as x(name text, weight numeric, drop_lowest_n integer default 0)
  loop
    insert into public.grade_categories (course_id, name, weight, drop_lowest_n)
    values (v_course_id, v_cat.name, v_cat.weight, coalesce(v_cat.drop_lowest_n, 0));
  end loop;

  -- Assignments: match category_name to categories we just created / that exist.
  for v_assignment in
    select * from jsonb_to_recordset(coalesce(payload -> 'assignments', '[]'::jsonb))
      as y(
        title text,
        category_name text,
        due_at timestamptz,
        max_score numeric default 100,
        description text,
        confidence jsonb default '{}'::jsonb
      )
  loop
    select gc.id into v_category_id
    from public.grade_categories gc
    where gc.course_id = v_course_id
      and lower(gc.name) = lower(btrim(coalesce(v_assignment.category_name, '')))
    limit 1;

    insert into public.assignments (course_id, category_id, title, due_at, max_score, description, confidence)
    values (
      v_course_id,
      v_category_id, -- null when unmatched (item 23: stay null, flagged in confidence)
      v_assignment.title,
      v_assignment.due_at,
      coalesce(v_assignment.max_score, 100),
      v_assignment.description,
      coalesce(v_assignment.confidence, '{}'::jsonb)
    );
  end loop;

  return v_course_id;
end;
$$;

-- Committing marks the upload as committed.
create or replace function public.mark_upload_committed(upload_id uuid, course uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.syllabus_uploads
  set status = 'committed', parse_result = parse_result || jsonb_build_object('course_id', course)
  where id = upload_id and owner_id = auth.uid();
$$;
