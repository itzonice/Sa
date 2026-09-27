-- Items 12, 14, 15, 16, 17, 19, 20: the RPC surface and the streak engine.
--
-- Everything the client can mutate goes through here rather than through direct
-- table writes, because three of the rules are not expressible as policies: the
-- server clock, the three-buddy cap, and the streak. Each mutating RPC takes a
-- client-generated uuid so a retry after a timeout is a no-op, not a duplicate.

-- -----------------------------------------------------------------------------
-- Item 16: streaks
-- -----------------------------------------------------------------------------

-- Consecutive calendar days, in the user's own timezone, with at least one
-- completed session. One missed day is a grace day: it neither extends nor
-- breaks the run. Two in a row resets it to 1.
--
-- Mirrors `applyCompletion` in packages/core/src/live/streak.ts; the shared
-- table of cases in that module's test and this function's pgtap test are what
-- keep the two implementations honest.
create or replace function public.recompute_streak(
  p_user_id uuid,
  p_completed_on date
)
returns table (streak_current integer, streak_longest integer, streak_last_day date)
language plpgsql
security definer
set search_path = public
as $$
declare
  profile public.profiles;
  next_current integer;
  next_longest integer;
begin
  select * into profile from public.profiles where id = p_user_id for update;

  if profile.id is null then
    raise exception 'profile % does not exist', p_user_id;
  end if;

  -- Idempotent per day: two sessions finished today must count once.
  if profile.streak_last_day = p_completed_on then
    return query
      select profile.streak_current, profile.streak_longest, profile.streak_last_day;
    return;
  end if;

  if profile.streak_last_day = p_completed_on - 1 then
    next_current := profile.streak_current + 1;          -- extended
  elsif profile.streak_last_day = p_completed_on - 2 then
    next_current := profile.streak_current;              -- held by the grace day
  else
    next_current := 1;                                   -- started or reset
  end if;

  next_longest := greatest(profile.streak_longest, next_current);

  update public.profiles
     set streak_current = next_current,
         streak_longest = next_longest,
         streak_last_day = p_completed_on
   where id = p_user_id;

  return query select next_current, next_longest, p_completed_on;
end;
$$;

comment on function public.recompute_streak is
  'Item 16: consecutive days with a completed session, one-day grace, idempotent per day.';

-- -----------------------------------------------------------------------------
-- Item 11 + 20: start a session
-- -----------------------------------------------------------------------------

create or replace function public.start_live_session(
  p_session_id uuid,
  p_code text,
  p_course_name text,
  p_planned_minutes integer
)
returns public.live_sessions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid := auth.uid();
  created public.live_sessions;
  existing public.live_sessions;
begin
  if v_owner is null then
    raise exception 'not authenticated';
  end if;

  if p_planned_minutes < 5 or p_planned_minutes > 480 then
    raise exception 'planned_minutes must be between 5 and 480, got %', p_planned_minutes;
  end if;

  if upper(p_code) !~ '^[A-Z0-9]{4,10}$' then
    raise exception 'code must be 4-10 characters of A-Z0-9, got %', p_code;
  end if;

  -- Idempotency is written out rather than expressed as ON CONFLICT DO UPDATE
  -- because this function is security definer: DO UPDATE would bypass the
  -- owner-only policy and let one user overwrite another's session row.
  select * into existing from public.live_sessions where id = p_session_id;

  if existing.id is not null then
    if existing.owner_id <> v_owner then
      raise exception 'session id already in use';
    end if;
    return existing;
  end if;

  -- started_at comes from now(), never from the client: this is what keeps two
  -- buddies' countdowns on the same timeline (item 14).
  insert into public.live_sessions (
    id, code, owner_id, course_name, planned_minutes, status, started_at
  ) values (
    p_session_id, upper(p_code), v_owner, btrim(p_course_name), p_planned_minutes,
    'active', now()
  )
  returning * into created;

  return created;
end;
$$;

-- -----------------------------------------------------------------------------
-- Item 12: join by code
-- -----------------------------------------------------------------------------

create or replace function public.join_live_session(
  p_participant_id uuid,
  p_session_id uuid,
  p_code text
)
returns public.live_session_participants
language plpgsql
security definer
set search_path = public
as $$
declare
  target public.live_sessions;
  created public.live_session_participants;
  existing public.live_session_participants;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  -- The code is part of the lookup, not just a check: a link that says
  -- /session/<id>?code=ABC123 cannot be edited into someone else's room.
  select * into target
    from public.live_sessions
   where id = p_session_id and code = upper(btrim(p_code))
   for update;

  if target.id is null then
    raise exception 'no live session matches that id and code';
  end if;

  if target.status <> 'active' then
    raise exception 'that live session has already ended';
  end if;

  if target.owner_id = auth.uid() then
    raise exception 'you are the host of this live session';
  end if;

  select * into existing
    from public.live_session_participants
   where session_id = p_session_id and user_id = auth.uid();

  -- Re-joining is a no-op, which makes a double-tapped Join button and a retry
  -- after a dropped connection both safe.
  if existing.id is not null then
    return existing;
  end if;

  insert into public.live_session_participants (
    id, session_id, user_id, role, joined_at, last_active_at
  ) values (
    p_participant_id, p_session_id, auth.uid(), 'buddy', now(), now()
  )
  returning * into created;

  return created;
end;
$$;

-- Item 20: leave. Idempotent by construction.
create or replace function public.leave_live_session(p_session_id uuid)
returns public.live_session_participants
language plpgsql
security definer
set search_path = public
as $$
declare
  existing public.live_session_participants;
begin
  select * into existing
    from public.live_session_participants
   where session_id = p_session_id and user_id = auth.uid()
   for update;

  if existing.id is null then
    raise exception 'not a participant of live session %', p_session_id;
  end if;

  if existing.left_at is not null then
    return existing;
  end if;

  update public.live_session_participants
     set left_at = now()
   where id = existing.id
  returning * into existing;

  return existing;
end;
$$;

-- Item 13: cheap heartbeat, and the freshness signal item 17 keys off.
create or replace function public.touch_live_presence(p_session_id uuid)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  stamped timestamptz := now();
begin
  update public.live_session_participants
     set last_active_at = stamped
   where session_id = p_session_id
     and user_id = auth.uid()
     and left_at is null;

  return stamped;
end;
$$;

-- -----------------------------------------------------------------------------
-- Item 15 + 16: end a session
-- -----------------------------------------------------------------------------

create or replace function public.end_live_session(
  p_session_id uuid,
  p_status public.live_session_status,
  p_recap_note text default null,
  p_actual_minutes integer default null
)
returns public.live_sessions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid := auth.uid();
  target public.live_sessions;
  finished timestamptz := now();
  minutes integer;
  uid uuid;
  user_tz text;
  completed_on date;
begin
  if v_owner is null then
    raise exception 'not authenticated';
  end if;

  if p_status not in ('done', 'missed') then
    raise exception 'end_live_session: status must be done or missed, got %', p_status;
  end if;

  select * into target from public.live_sessions where id = p_session_id for update;

  if target.id is null then
    raise exception 'live session % not found', p_session_id;
  end if;

  if target.owner_id <> v_owner then
    raise exception 'only the session owner can end it';
  end if;

  -- Idempotent: ending an already-terminal session returns it unchanged.
  if target.status in ('done', 'missed') then
    return target;
  end if;

  if target.started_at is null then
    raise exception 'live session % was never started', p_session_id;
  end if;

  if p_actual_minutes is not null then
    minutes := p_actual_minutes;
  else
    minutes := greatest(0, floor(extract(epoch from (finished - target.started_at)) / 60)::int);
  end if;

  -- "Done" always counts at least a minute; a day-plus is clock nonsense, not
  -- studying.
  minutes := least(greatest(minutes, case when p_status = 'done' then 1 else 0 end), 1440);

  update public.live_sessions
     set status = p_status,
         ended_at = finished,
         ended_reason = case when p_status = 'done' then 'completed' else 'missed' end,
         actual_minutes = minutes,
         recap_note = nullif(btrim(coalesce(p_recap_note, '')), '')
   where id = p_session_id
  returning * into target;

  -- Everyone who took part gets their streak advanced, so a buddy's streak
  -- counts a session they completed. The calendar day is resolved per user, so
  -- the same instant is "today" in Lisbon and "yesterday" in Auckland.
  if target.status = 'done' then
    for uid, user_tz, completed_on in
      select p.id,
             p.timezone,
             (finished at time zone p.timezone)::date
        from public.profiles p
       where p.id = target.owner_id
          or exists (
            select 1
              from public.live_session_participants lp
             where lp.session_id = target.id
               and lp.user_id = p.id
          )
    loop
      perform public.recompute_streak(uid, completed_on);
    end loop;
  end if;

  return target;
end;
$$;

-- -----------------------------------------------------------------------------
-- Item 17: nudge
-- -----------------------------------------------------------------------------

create or replace function public.nudge_live_buddy(
  p_nudge_id uuid,
  p_session_id uuid,
  p_target_user_id uuid
)
returns public.live_session_nudges
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sender uuid := auth.uid();
  created public.live_session_nudges;
begin
  if not public.is_live_session_member(p_session_id, v_sender) then
    raise exception 'not a member of live session %', p_session_id;
  end if;

  if p_target_user_id = v_sender then
    raise exception 'cannot nudge yourself';
  end if;

  if not exists (
    select 1
      from public.live_session_participants
     where session_id = p_session_id
       and user_id = p_target_user_id
  ) then
    raise exception 'target is not in this live session';
  end if;

  insert into public.live_session_nudges (id, session_id, from_user_id, to_user_id, sent_at)
  values (p_nudge_id, p_session_id, v_sender, p_target_user_id, now())
  on conflict (id) do update set id = excluded.id
  returning * into created;

  return created;
end;
$$;

-- -----------------------------------------------------------------------------
-- grants
--
-- Scoped, not `revoke all on all functions`: Supabase's default privileges
-- already grant EXECUTE on new public-schema functions to anon and
-- authenticated, and a blanket revoke would strip the pre-existing RPCs from
-- 0003/0006/0007 along with ours. So the two security definer helpers that must
-- not be client-reachable are revoked by name, and the client-facing ones are
-- granted by name.
-- -----------------------------------------------------------------------------

revoke execute on function
  public.recompute_streak(uuid, date),
  public.live_assert_not_busy(uuid, uuid, timestamptz),
  public.live_user_is_busy(uuid, uuid)
from public, anon, authenticated;

revoke execute on function
  public.live_check_planned_minutes(integer)
from anon;

grant execute on function
  public.live_invite_card(text),
  public.live_session_id_from_topic(text),
  public.is_live_session_member(uuid, uuid),
  public.owns_live_session(uuid, uuid),
  public.live_server_now(),
  public.start_live_session(uuid, text, text, integer),
  public.join_live_session(uuid, uuid, text),
  public.leave_live_session(uuid),
  public.end_live_session(uuid, public.live_session_status, text, integer),
  public.touch_live_presence(uuid),
  public.nudge_live_buddy(uuid, uuid, uuid)
to authenticated;

grant execute on function
  public.recompute_streak(uuid, date),
  public.live_assert_not_busy(uuid, uuid, timestamptz)
to service_role;

grant select, insert, update, delete on public.live_sessions to authenticated;
grant select, insert, update, delete on public.live_session_participants to authenticated;
grant select on public.live_session_nudges to authenticated;
