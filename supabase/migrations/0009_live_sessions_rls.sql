-- Items 8 and 21: RLS for the live-session tables, plus realtime authorization.
--
-- The rule from the spec: you see the sessions you own plus the sessions you are
-- a participant in. Nobody else. That is deliberately wider than the owner-only
-- policy used everywhere else in this schema (item 9), and narrower than "anyone
-- with the code".

-- Recursion-safe membership helpers. A policy on live_session_participants
-- cannot sub-select live_session_participants without infinite recursion, so
-- membership resolves through security definer functions with a pinned
-- search_path, in the same shape as public.is_course_owner from 0003.

create or replace function public.is_live_session_member(
  p_session_id uuid,
  p_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.live_sessions s
     where s.id = p_session_id and s.owner_id = p_user_id
  )
  or exists (
    select 1 from public.live_session_participants p
     where p.session_id = p_session_id and p.user_id = p_user_id
  );
$$;

create or replace function public.owns_live_session(
  p_session_id uuid,
  p_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.live_sessions s
     where s.id = p_session_id and s.owner_id = p_user_id
  );
$$;

comment on function public.is_live_session_member is
  'Item 8: true for the host and for any buddy, past or present.';

alter table public.live_sessions enable row level security;
alter table public.live_session_participants enable row level security;
alter table public.live_session_nudges enable row level security;

-- Item 8: owned or participating. This is the policy the RLS audit (item 23)
-- exercises with a user who is in no way connected to the session.
create policy "live_sessions_select_member" on public.live_sessions
  for select to authenticated
  using (public.is_live_session_member(id, auth.uid()));

create policy "live_sessions_insert_own" on public.live_sessions
  for insert to authenticated
  with check (owner_id = auth.uid());

create policy "live_sessions_update_own" on public.live_sessions
  for update to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

create policy "live_sessions_delete_own" on public.live_sessions
  for delete to authenticated
  using (owner_id = auth.uid());

-- Buddies need to see the roster; the host needs to see who showed up.
create policy "live_participants_select_member" on public.live_session_participants
  for select to authenticated
  using (public.is_live_session_member(session_id, auth.uid()));

-- Only a client acting as itself may add its own row; the buddy-count, joinable
-- and overlap rules live in triggers (0008), which run as the table owner.
create policy "live_participants_insert_self" on public.live_session_participants
  for insert to authenticated
  with check (user_id = auth.uid());

create policy "live_participants_update_self" on public.live_session_participants
  for update to authenticated
  using (user_id = auth.uid() or public.owns_live_session(session_id, auth.uid()))
  with check (user_id = auth.uid() or public.owns_live_session(session_id, auth.uid()));

-- Nudges are private to the two people involved.
create policy "live_nudges_select_involved" on public.live_session_nudges
  for select to authenticated
  using (from_user_id = auth.uid() or to_user_id = auth.uid());

-- Profiles: the existing 0003 policy lets a user read only their own row, which
-- would leave a buddy's name blank in the presence list. Widening it to "people
-- who share a live session with me" is the minimum needed for item 13, and
-- exposes nothing beyond name, avatar and timezone.
create policy "profiles_select_live_peers" on public.profiles
  for select to authenticated
  using (
    id in (
      select p.user_id
        from public.live_session_participants p
       where p.user_id = auth.uid()
      union
      select other.user_id
        from public.live_session_participants p
        join public.live_session_participants other on other.session_id = p.session_id
       where p.user_id = auth.uid()
      union
      -- The host, for buddies who are not themselves in any session.
      select s.owner_id
        from public.live_session_participants p
        join public.live_sessions s on s.id = p.session_id
       where p.user_id = auth.uid()
    )
  );

-- Item 21: realtime channels are named `session:<uuid>` and are private, so the
-- check is re-run by realtime.messages' own RLS on every subscribe and every
-- message rather than trusted from the client.
create or replace function public.live_session_id_from_topic(p_topic text)
returns uuid
language plpgsql
immutable
as $$
declare
  captured text;
begin
  captured := substring(p_topic from 'session:([0-9a-fA-F-]{36})');
  if captured is null then
    return null;
  end if;
  return captured::uuid;
exception when others then
  -- A malformed topic must fail closed (null), not raise inside a policy.
  return null;
end;
$$;

do $$
begin
  if to_regclass('realtime.messages') is not null then
    execute $policy$
      create policy "live session members may subscribe"
        on realtime.messages
        for select
        to authenticated
        using (
          extension in ('presence', 'broadcast')
          and public.is_live_session_member(
            public.live_session_id_from_topic(realtime.topic()),
            auth.uid()
          )
        );
    $policy$;

    execute $policy$
      create policy "live session members may publish"
        on realtime.messages
        for insert
        to authenticated
        with check (
          extension in ('presence', 'broadcast')
          and public.is_live_session_member(
            public.live_session_id_from_topic(realtime.topic()),
            auth.uid()
          )
        );
    $policy$;
  end if;
exception
  when undefined_object or insufficient_privilege then
    raise notice 'realtime.messages not present; skipping realtime policies';
end;
$$;

-- Realtime is opt-in per table. Session participants are the only stream the
-- live view needs; everything else is fetched on demand.
alter table public.live_session_participants replica identity full;

-- The invite card is the one read that must work for a user who is not yet in
-- the session, and it exposes only what the join screen renders.
create or replace function public.live_invite_card(p_code text)
returns table (
  session_id uuid,
  code text,
  course_name text,
  planned_minutes integer,
  started_at timestamptz,
  status public.live_session_status,
  host_display_name text,
  spots_left integer
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  return query
  select
    s.id,
    s.code,
    s.course_name,
    s.planned_minutes,
    s.started_at,
    s.status,
    h.display_name,
    greatest(0, 3 - (
      select count(*)
        from public.live_session_participants p
       where p.session_id = s.id and p.left_at is null
    ))::integer
  from public.live_sessions s
  join public.profiles h on h.id = s.owner_id
  where s.code = upper(btrim(p_code));
end;
$$;
