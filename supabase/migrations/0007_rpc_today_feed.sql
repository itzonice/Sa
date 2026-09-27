-- Item 33: Today feed RPC — ranked tasks for the user's local day.
-- Review/quiz items first (item 40 lives here too), then priority-ranked work,
-- capped by the user's available study minutes.

create or replace function public.today_feed(p_local_date date, p_available_minutes integer default 120)
returns table (
  item_kind text,          -- 'review_card_quiz' | 'make_cards_task' | 'assignment'
  item_id uuid,
  course_id uuid,
  title text,
  due_at timestamptz,
  priority numeric,
  estimated_minutes integer,
  reason text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_owner uuid := auth.uid();
  v_minutes_left integer := greatest(coalesce(p_available_minutes, 120), 0);
  v_priority numeric;
  v_est integer;
begin
  if v_owner is null then
    raise exception 'not authenticated';
  end if;

  -- 1) Due review items first (cards flagged as quiz items for this course/day, item 40).
  return query
  select
    'review_card_quiz'::text,
    c.id,
    c.course_id,
    left(c.question, 80),
    p_local_date::timestamptz,
    1000::numeric, -- always above regular tasks
    5::integer,
    'Due review (closed-note quiz)'::text
  from public.study_cards c
  where c.owner_id = v_owner
    and c.is_quiz_item
    and c.created_at::date < p_local_date -- created before today => due for review
  limit 20;

  -- The review quota is small and fixed; remaining minutes go to ranked tasks.
  v_minutes_left := v_minutes_left - (select coalesce(count(*), 0) * 5 from study_cards where owner_id = v_owner and is_quiz_item and created_at::date < p_local_date limit 20);
  v_minutes_left := greatest(v_minutes_left, 0);

  -- 2) Card-making tasks from course meetings (item 38).
  return query
  select
    'make_cards_task'::text,
    a.id,
    a.course_id,
    a.title,
    a.due_at,
    900::numeric,
    10::integer,
    'Post-class card task'::text
  from public.assignments a
  where a.is_card_task
    and a.status in ('not_started', 'in_progress')
    and public.is_course_owner(a.course_id)
    and a.due_at >= p_local_date::timestamptz
    and a.due_at < (p_local_date + 1)::timestamptz
  limit 10;

  -- 3) Ranked assignments (priority from the scheduler package, mirrored in SQL).
  return query
  select
    'assignment'::text,
    a.id,
    a.course_id,
    a.title,
    a.due_at,
    (100
      + coalesce(gc.weight, 0) * 2
      - greatest(extract(epoch from (a.due_at - now())) / 86400.0, 0) * 3
      + case a.status when 'in_progress' then 25 when 'submitted' then 10 else 0 end
    )::numeric,
    least(90, greatest(20, (coalesce(gc.weight, 10) * 1.5))::int),
    case
      when a.due_at < now() then 'Overdue'
      when a.due_at < (p_local_date + 2)::timestamptz then 'Due within 48h'
      else 'Weight: ' || coalesce(gc.weight, 0)::text || '%'
    end
  from public.assignments a
  left join public.grade_categories gc on gc.id = a.category_id
  where public.is_course_owner(a.course_id)
    and a.status in ('not_started', 'in_progress')
  order by priority desc
  limit 25;
end;
$$;
