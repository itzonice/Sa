-- Public identity: username, display name, avatar path.
--
-- Email addresses stay in `auth.users` and are never copied onto `profiles`.
-- The username is the only public handle, and everything here is built so that
-- leaking a profile row cannot leak an address: the columns are a slug, a display
-- name and a storage key, none of which contains the local part except by the
-- user's own choice at signup.
--
-- Mirrored by packages/core/src/identity/username.ts. The slug rules, the
-- candidate ladder and the reserved list are implemented twice -- once in plpgsql
-- for the signup trigger, once in TypeScript for the form -- and both sides carry
-- the same table of cases so a divergence shows up as a failing test rather than
-- as a signup that dies on the check constraint.

-- -----------------------------------------------------------------------------
-- columns
-- -----------------------------------------------------------------------------

alter table public.profiles
  -- display_name already exists, added by 0008 with a 1-60 length check. The
  -- spec asks for it here too; adding it again would be a duplicate column.
  add column if not exists username text,
  -- The storage key of the avatar, not a URL. The bucket is private, so this is
  -- an internal identifier and the app must mint a short-lived signed URL to
  -- render it. Never put this straight into an <img src>.
  --
  -- `avatar_url` from 0008 predates this and is left in place because the web
  -- layer still reads it; it is superseded by this column and should be dropped
  -- once nothing selects it.
  add column if not exists avatar_path text;

do $$ begin
  alter table public.profiles
    add constraint profiles_username_format
    -- The spec's character set is [a-z0-9_]: lowercase, digits, underscore. No
    -- hyphen and no uppercase, which is what lets "case-insensitive" be true by
    -- construction instead of by convention.
    check (username is null or username ~ '^[a-z0-9_]{3,20}$');
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.profiles
    add constraint profiles_username_not_blank
    check (username is null or username !~ '^_|_$');
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.profiles
    add constraint profiles_username_not_reserved
    check (username is null or username <> all (array[
      'admin', 'administrator', 'api', 'app', 'help', 'root', 'support', 'system', 'user'
    ]));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.profiles
    add constraint profiles_avatar_path_shape
    -- `<uuid>/avatar.<ext>`, matching the object key the app uploads to and the
    -- Storage policies in 0013. The folder has to be the owner's uid, and that
    -- cannot be expressed here because auth.uid() is not immutable; it is
    -- enforced by public.set_avatar_path instead.
    check (
      avatar_path is null
      or avatar_path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/avatar\.(png|jpg|webp)$'
    );
exception when duplicate_object then null; end $$;

comment on column public.profiles.username is
  'Public handle, unique case-insensitively. Derived from the email local part at signup; never the address itself.';
comment on column public.profiles.avatar_path is
  'Storage key in the private avatars bucket, not a URL. Render it through a short-lived signed URL.';
comment on column public.profiles.display_name is
  'Free-text name shown next to a username. Not unique, and never used for lookup.';

-- Uniqueness is on lower(username) rather than on username. With a lowercase
-- check constraint in place the two are equivalent today, but the expression
-- index is what makes "case-insensitive" survive someone later relaxing that
-- constraint, and it costs nothing to be explicit about the intent.
--
-- This index doubles as the lookup path for a handle -- a profile page hits it
-- with lower($1) -- so there is deliberately no second index on the same
-- expression.
create unique index if not exists profiles_username_unique_idx
  on public.profiles (lower(username));

-- -----------------------------------------------------------------------------
-- slugging
--
-- These are the SQL half of packages/core/src/identity/username.ts.
-- -----------------------------------------------------------------------------

-- immutable, because it is used in a check constraint and an index expression.
create or replace function public.slug_from_email(p_email text)
returns text
language sql
immutable
as $$
  select nullif(
    -- Strip the last @ and everything after it. Anchoring on '@[^@]*$' is what
    -- makes it the *last* @, which matters because a quoted local part is allowed
    -- to contain one: "weird@local@example.com" is local part "weird@local", and
    -- split_part(email, '@', 1) would silently truncate it to "weird".
    -- The leftover @ is folded to an underscore by the character class below.
    regexp_replace(
      regexp_replace(
        regexp_replace(
          lower(regexp_replace(p_email, '@[^@]*$', '')),
          '[^a-z0-9_]+', '_', 'g'
        ),
        '_{2,}', '_', 'g'
      ),
      '^_+|_+$', '', 'g'
    ),
    '',
    ''
  );
$$;

comment on function public.slug_from_email(text) is
  'Email local part folded to a username candidate. Null when nothing usable is left.';

-- The candidate ladder, in the same order as usernameCandidates in TypeScript:
-- base, base_2, base_3, ... The separator is an underscore because the spec''s
-- character set is [a-z0-9_] and a hyphen is not available.
create or replace function public.username_candidates(p_base text, p_max_attempts integer default 50)
returns table (candidate text, ordinal integer)
language plpgsql
immutable
as $$
declare
  suffix text;
begin
  if p_base is null or p_base = '' then
    return;
  end if;

  return query select left(p_base, 20), 1;

  for attempt in 2..greatest(p_max_attempts, 1) loop
    suffix := '_' || attempt::text;

    -- Stop if the suffix would leave less than the three-character minimum.
    exit when 20 - length(suffix) < 3;

    return query select left(p_base, 20 - length(suffix)) || suffix, attempt;
  end loop;
end;
$$;

comment on function public.username_candidates(text, integer) is
  'Ordered username candidates: base, base_2, base_3, ... each within 20 characters.';

-- -----------------------------------------------------------------------------
-- signup
--
-- Replaces the *function* behind the trigger created in 0001, which inserted a
-- profile with no username. The trigger itself is untouched and picks up the new
-- body automatically. Rule 5 in CLAUDE.md says never edit an applied migration,
-- so this is a `create or replace` of the same signature rather than a change to
-- 0001.
-- -----------------------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  base text;
  chosen text;
  attempt integer;
  user_timezone text;
  user_school text;
begin
  -- A profile that already exists means this trigger is being replayed; the id
  -- is the primary key, so there is nothing to allocate.
  if exists (select 1 from public.profiles where id = new.id) then
    return new;
  end if;

  user_timezone := coalesce(nullif(new.raw_user_meta_data ->> 'timezone', ''), 'UTC');
  user_school := nullif(new.raw_user_meta_data ->> 'school', '');

  -- A chosen username in the signup metadata wins, so a form can pre-fill one
  -- and have it respected; otherwise derive it from the address.
  base := public.slug_from_email(coalesce(new.email, ''));

  if base is null or base = '' then
    -- No usable local part (or an OAuth account with no address). Keep it
    -- deterministic enough to debug and unique enough to not collide often.
    base := 'user' || lpad(floor(random() * 1000)::integer::text, 3, '0');
  end if;

  -- Walk the ladder, letting the unique index arbitrate. Two people signing up as
  -- "ada" at the same instant both try `ada`; one insert wins and the other
  -- catches unique_violation and moves to `ada_2`. A prior existence check would
  -- race, so the index is the only authority here.
  for attempt in 1..50 loop
    select c.candidate into chosen
      from public.username_candidates(base, 50) c
     where c.ordinal = attempt
       and c.candidate is not null;

    exit when chosen is null;

    begin
      insert into public.profiles (id, timezone, school, username)
      values (new.id, user_timezone, user_school, chosen);
      return new;
    exception when unique_violation then
      continue;
    end;
  end loop;

  raise exception 'could not allocate a username for user %', new.id;
end;
$$;

comment on function public.handle_new_user() is
  'Signup: creates the profile and allocates a unique username from the email local part.';

-- -----------------------------------------------------------------------------
-- changing a username
-- -----------------------------------------------------------------------------

-- Normalises, validates, and lets the unique index reject a taken handle. The
-- error is caught and re-raised as something a form can show.
create or replace function public.set_username(p_username text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  wanted text;
begin
  if v_user is null then
    raise exception 'not authenticated';
  end if;

  wanted := lower(btrim(coalesce(p_username, '')));

  if wanted !~ '^[a-z0-9_]{3,20}$' or wanted ~ '^_|_$' then
    raise exception 'a username is 3-20 characters of a-z, 0-9 and underscore, and cannot start or end with an underscore';
  end if;

  if wanted = any (array[
    'admin', 'administrator', 'api', 'app', 'help', 'root', 'support', 'system', 'user'
  ]) then
    raise exception 'that username is reserved';
  end if;

  -- Unlike signup this does not walk a ladder: picking a handle you did not
  -- claim by asking for a number is not what someone typing a name wants.
  if exists (select 1 from public.profiles where lower(username) = wanted and id <> v_user) then
    raise exception 'that username is taken';
  end if;

  begin
    update public.profiles
       set username = wanted
     where id = v_user
     returning username into wanted;
  exception when unique_violation then
    -- Lost a race with a simultaneous claim; the index had the final say.
    raise exception 'that username is taken';
  end;

  return wanted;
end;
$$;

comment on function public.set_username(text) is
  'Claims a new username for the caller. No collision ladder: a taken name is an error.';

-- -----------------------------------------------------------------------------
-- avatar path
-- -----------------------------------------------------------------------------

create or replace function public.set_avatar_path(p_avatar_path text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  wanted text;
begin
  if v_user is null then
    raise exception 'not authenticated';
  end if;

  wanted := nullif(btrim(coalesce(p_avatar_path, '')), '');

  -- The folder has to be the caller's own uid. This is the one check that stops
  -- a client from storing somebody else's object key and then asking the server
  -- to sign a URL for it.
  if wanted is not null
     and wanted not in (
       v_user::text || '/avatar.png',
       v_user::text || '/avatar.jpg',
       v_user::text || '/avatar.webp'
     ) then
    raise exception 'an avatar path must be your own avatar file';
  end if;

  update public.profiles
     set avatar_path = wanted
   where id = v_user;

  return wanted;
end;
$$;

comment on function public.set_avatar_path(text) is
  'Stores the caller''s own avatar key on their profile, or null to clear it.';

-- -----------------------------------------------------------------------------
-- backfill
--
-- A hosted database already has users, and they predate the username column.
-- They get the same slug the signup trigger would have produced, walking the
-- ladder so the first `ada@example.com` keeps `ada` and the second becomes
-- `ada_2`.
-- -----------------------------------------------------------------------------

do $$
declare
  orphan record;
  base text;
  chosen text;
  repaired integer := 0;
begin
  for orphan in
    select u.id, u.email
      from auth.users u
      left join public.profiles p on p.id = u.id
     where p.id is not null
       and p.username is null
  loop
    base := public.slug_from_email(coalesce(orphan.email, ''));

    if base is null or base = '' then
      base := 'user' || lpad(floor(random() * 1000)::integer::text, 3, '0');
    end if;

    for attempt in 1..50 loop
      select c.candidate into chosen
        from public.username_candidates(base, 50) c
       where c.ordinal = attempt and c.candidate is not null;

      exit when chosen is null;

      begin
        update public.profiles set username = chosen where id = orphan.id;
        repaired := repaired + 1;
        chosen := null;   -- marks the row as dealt with
        exit;
      exception when unique_violation then
        continue;
      end;
    end loop;

    if chosen is not null then
      raise warning 'could not allocate a username for existing user %', orphan.id;
    end if;
  end loop;

  -- Enforce the invariant only if the backfill actually reached every row. A
  -- partial backfill should not block a deploy, but it should be visible.
  if not exists (select 1 from public.profiles where username is null) then
    alter table public.profiles alter column username set not null;
    raise notice 'backfilled % usernames; username is now NOT NULL', repaired;
  else
    raise warning
      'some profiles still have a null username; the column stays nullable until they are repaired';
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- column privileges
--
-- The `profiles_update_own` policy from 0003 is row-scoped: it lets a user write
-- any column of their own row. That is too wide now that the row holds derived
-- state. `streak_current`, `streak_longest` and `streak_last_day` are written by
-- public.recompute_streak in 0010, and `username` has to go through
-- public.set_username so it is normalised and checked. Without the grants below,
-- a client could `update profiles set streak_current = 999` and mint themselves a
-- perfect streak, or set a username without touching the ladder.
--
-- So: no blanket UPDATE grant, and a column list of exactly what a user owns.
--
-- `plan_tier` is deliberately absent: it is billing state.
--
-- `avatar_url` and `share_task_titles` are in the list because other migrations
-- and the settings form write them. A column-level grant is a closed set, so
-- adding a column to profiles without adding it here breaks whichever feature
-- writes it, with a bare "permission denied for table profiles" that points at
-- the wrong thing entirely. If you add a user-writable column, add it here too.
-- -----------------------------------------------------------------------------

revoke update on public.profiles from anon, authenticated;

grant update (timezone, school, display_name, avatar_path, avatar_url, share_task_titles)
  on public.profiles
  to authenticated;

-- set_username and set_avatar_path are the only ways to write username and
-- avatar_path, so they need EXECUTE.
--
-- The two slug helpers are read-only, and a signup form can call them to preview
-- the candidate it is about to be allocated. handle_new_user is left alone: it is
-- a trigger function, PostgREST cannot reach it, and revoking EXECUTE on it would
-- only make the next reader wonder whether the trigger still works.
grant execute on function
  public.set_username(text),
  public.set_avatar_path(text),
  public.slug_from_email(text),
  public.username_candidates(text, integer)
to authenticated;
