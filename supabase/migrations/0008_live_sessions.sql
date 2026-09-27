-- Items 5-9: live co-study sessions.
--
-- Naming: `study_blocks` (item 13) is a scheduled calendar slot and
-- `study_sessions` is a logged block of past studying. This feature is a third
-- thing -- a session that is running *right now* with a countdown, a share code
-- and up to three buddies -- so it gets its own tables rather than bending
-- either of those into a shape their callers do not want.
--
-- Conventions (CLAUDE.md):
--   * every instant is timestamptz; a "day" is a date in profiles.timezone
--   * client-generated uuid primary keys so writes are idempotent under retry
--   * derived columns are written by the database, never by the client

-- Item 5: display fields the live view and presence need.
alter table public.profiles
  add column if not exists display_name text,
  add column if not exists avatar_url text,
  -- Item 16: owned by the streak engine in 0010, read-only to clients.
  add column if not exists streak_current integer not null default 0,
  add column if not exists streak_longest integer not null default 0,
  -- Calendar day (in profiles.timezone) of the last completed session.
  add column if not exists streak_last_day date;

do $$ begin
  alter table public.profiles
    add constraint profiles_display_name_len
    check (display_name is null or char_length(btrim(display_name)) between 1 and 60);
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.profiles
    add constraint profiles_streak_non_negative
    check (streak_current >= 0 and streak_longest >= 0);
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.profiles
    add constraint profiles_streak_longest_covers_current
    check (streak_longest >= streak_current);
exception when duplicate_object then null; end $$;

comment on table public.profiles is
  'One row per auth user; timezone is the source of truth for all local-time conversions.';

-- Item 6: the session itself.
create type public.live_session_status as enum ('planned', 'active', 'done', 'missed');
create type public.live_participant_role as enum ('host', 'buddy');

create table public.live_sessions (
  id uuid primary key default gen_random_uuid(),
  -- Short human-typable join code (item 12). Upper-case, unambiguous alphabet.
  code text not null unique,
  owner_id uuid not null references public.profiles (id) on delete cascade,
  -- Free text on purpose: a buddy can join a friend who has not created a
  -- `courses` row yet. Linking to courses is future work.
  course_name text not null,
  -- Item 9: the 5-480 minute window.
  planned_minutes integer not null,
  started_at timestamptz,
  ended_at timestamptz,
  status public.live_session_status not null default 'planned',
  ended_reason text,
  -- Item 15: minutes actually studied, derived from the server clock.
  actual_minutes integer,
  -- Item 18: private to the owner, never shared with buddies.
  recap_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint live_sessions_planned_minutes_range
    check (planned_minutes between 5 and 480),
  constraint live_sessions_code_format
    check (code ~ '^[A-Z0-9]{4,10}$'),
  constraint live_sessions_course_name_len
    check (char_length(btrim(course_name)) between 1 and 80),
  constraint live_sessions_recap_note_len
    check (recap_note is null or char_length(btrim(recap_note)) between 1 and 280),
  constraint live_sessions_ended_reason_valid
    check (ended_reason is null or ended_reason in ('completed', 'missed')),

  -- Lifecycle: a planned session has no clock running yet.
  constraint live_sessions_planned_has_no_start
    check (status <> 'planned' or started_at is null),
  constraint live_sessions_started_has_no_end
    check (ended_at is null or started_at is not null),
  constraint live_sessions_active_has_start
    check (status <> 'active' or started_at is not null),
  -- An ended session always has an end instant and a duration.
  constraint live_sessions_ended_is_terminal
    check (ended_at is null or status in ('done', 'missed')),
  constraint live_sessions_end_after_start
    check (ended_at is null or ended_at >= started_at),
  constraint live_sessions_minutes_present_when_ended
    check (ended_at is null or actual_minutes is not null),
  constraint live_sessions_actual_minutes_valid
    check (actual_minutes is null or actual_minutes between 0 and 1440),
  -- "Done" has to mean something happened.
  constraint live_sessions_done_has_minutes
    check (status <> 'done' or coalesce(actual_minutes, 0) >= 1)
);

comment on table public.live_sessions is
  'A running co-study session. Visible to the owner and to its buddies only.';

create index live_sessions_owner_created_idx
  on public.live_sessions (owner_id, created_at desc);

-- Partial index for the one query that matters on the hot path: "is this user
-- already in a running session?".
create index live_sessions_active_idx
  on public.live_sessions (owner_id)
  where status = 'active';

-- Item 7: buddies. The owner is *not* a row here -- ownership is owner_id --
-- which keeps "up to three buddies" a pure count.
create table public.live_session_participants (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.live_sessions (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  role public.live_participant_role not null default 'buddy',
  joined_at timestamptz not null default now(),
  left_at timestamptz,
  -- Item 13: durable last-active, unlike the ephemeral Realtime presence.
  last_active_at timestamptz not null default now(),

  constraint live_participants_unique_per_user
    unique (session_id, user_id),
  constraint live_participants_left_after_joined
    check (left_at is null or left_at >= joined_at),
  constraint live_participants_last_active_after_joined
    check (last_active_at >= joined_at)
);

create index live_participants_user_idx
  on public.live_session_participants (user_id, session_id);

-- Item 17: the nudge audit trail and the source of truth for the 3-per-session
-- cap, so the cap cannot be bypassed by calling the RPC directly.
create table public.live_session_nudges (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.live_sessions (id) on delete cascade,
  from_user_id uuid not null references public.profiles (id) on delete cascade,
  to_user_id uuid not null references public.profiles (id) on delete cascade,
  sent_at timestamptz not null default now(),

  constraint live_nudges_no_self check (from_user_id <> to_user_id)
);

create index live_nudges_per_session_idx
  on public.live_session_nudges (session_id, from_user_id, sent_at);

-- Item 9: planned_minutes is bounded above, so a session can never be longer
-- than a working day.
create or replace function public.live_check_planned_minutes(p_minutes integer)
returns void
language plpgsql
immutable
as $$
begin
  if p_minutes < 5 or p_minutes > 480 then
    raise exception 'planned_minutes must be between 5 and 480, got %', p_minutes;
  end if;
end;
$$;

-- Item 9 (enforced): no user may be in two running sessions at once. A CHECK
-- constraint cannot see across two tables, so this is a trigger, and it takes an
-- advisory lock keyed on the user so two concurrent starts cannot both pass.
create or replace function public.live_user_is_busy(
  p_user_id uuid,
  p_session_id uuid default null
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.live_sessions s
     where s.owner_id = p_user_id
       and s.status = 'active'
       and (p_session_id is null or s.id <> p_session_id)
  )
  or exists (
    select 1
      from public.live_session_participants p
      join public.live_sessions s on s.id = p.session_id
     where p.user_id = p_user_id
       and p.left_at is null
       and s.status = 'active'
       and (p_session_id is null or p.session_id <> p_session_id)
  );
$$;

create or replace function public.live_assert_not_busy(
  p_user_id uuid,
  p_session_id uuid,
  p_when timestamptz
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  -- Arbitrary but stable key: serialises the "is this user busy?" check.
  lock_key bigint := hashtextextended(p_user_id::text, 8121);
begin
  perform pg_advisory_xact_lock(lock_key);

  if public.live_user_is_busy(p_user_id, p_session_id) then
    raise exception 'user % already has an active session at %', p_user_id, p_when;
  end if;
end;
$$;

create or replace function public.live_guard_owner_overlap()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'active' then
    -- OLD is unassigned on INSERT, so the branches cannot be merged with OR.
    if tg_op = 'INSERT' then
      perform public.live_assert_not_busy(new.owner_id, new.id, now());
    elsif old.status is distinct from 'active' then
      perform public.live_assert_not_busy(new.owner_id, new.id, now());
    end if;
  end if;
  return new;
end;
$$;

create trigger live_sessions_guard_owner_overlap
  before insert or update of status on public.live_sessions
  for each row execute function public.live_guard_owner_overlap();

-- Item 7: at most three buddies, enforced atomically at insert time. A CHECK
-- cannot count rows, so this trigger is the only place the limit lives.
create or replace function public.live_guard_buddy_count()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  buddy_count integer;
begin
  select count(*) into buddy_count
    from public.live_session_participants
   where session_id = new.session_id
     and left_at is null;

  if buddy_count >= 3 then
    raise exception 'session % already has 3 active buddies', new.session_id;
  end if;

  return new;
end;
$$;

create trigger live_participants_guard_buddy_count
  before insert on public.live_session_participants
  for each row execute function public.live_guard_buddy_count();

create or replace function public.live_guard_buddy_join()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  target public.live_sessions;
begin
  select * into target
    from public.live_sessions
   where id = new.session_id
   for update;

  if target.id is null then
    raise exception 'live session % does not exist', new.session_id;
  end if;

  -- Cross-table rules: the host is owner_id, not a participant row, and only a
  -- running session can take a buddy.
  if target.owner_id = new.user_id then
    raise exception 'host cannot join their own live session as a buddy';
  end if;

  if target.status <> 'active' then
    raise exception 'live session % is not joinable (status=%)', new.session_id, target.status;
  end if;

  return new;
end;
$$;

create trigger live_participants_guard_buddy_join
  before insert on public.live_session_participants
  for each row execute function public.live_guard_buddy_join();

create or replace function public.live_guard_buddy_overlap()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.live_assert_not_busy(new.user_id, new.session_id, new.joined_at);
  return new;
end;
$$;

create trigger live_participants_guard_buddy_overlap
  before insert on public.live_session_participants
  for each row execute function public.live_guard_buddy_overlap();

create or replace function public.live_guard_nudge_quota()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  sent_count integer;
begin
  -- BEFORE INSERT fires even for rows that will conflict, so a retried request
  -- (same client-generated id) must not be charged against the quota.
  if exists (select 1 from public.live_session_nudges where id = new.id) then
    return new;
  end if;

  select count(*) into sent_count
    from public.live_session_nudges
   where session_id = new.session_id
     and from_user_id = new.from_user_id;

  if sent_count >= 3 then
    raise exception 'nudge limit reached for session %', new.session_id;
  end if;

  return new;
end;
$$;

create trigger live_nudges_guard_quota
  before insert on public.live_session_nudges
  for each row execute function public.live_guard_nudge_quota();

create trigger live_sessions_touch_updated_at
  before update on public.live_sessions
  for each row execute function public.touch_updated_at();

-- Item 14: the only clock the countdown is allowed to trust.
create or replace function public.live_server_now()
returns timestamptz
language sql
stable
as $$
  select now();
$$;
