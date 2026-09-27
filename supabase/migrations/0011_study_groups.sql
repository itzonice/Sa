-- G2: invite-only study groups.
--
-- The shape of the access model, stated up front because it is the whole point:
-- a group is reachable only by (a) being a member of it or (b) holding its exact
-- 6-character invite code. There is deliberately no search, no listing, no
-- school-wide or public directory, and no policy that lets a non-member see
-- that a group exists. The invite code is the only door in, which is why it is
-- rotatable and why `study_group_from_invite_code` returns the group's name and
-- nothing else.
--
-- Everything a client can write goes through a security definer function rather
-- than a table grant, because two of the rules are not expressible as policies:
-- the 12-member cap needs a count under a lock, and a group must never exist
-- without its owner's membership row.

create type public.study_group_role as enum ('owner', 'member');

-- Crockford base32: the digits plus the alphabet with I, L, O and U removed, so
-- a code read aloud or copied off a whiteboard has no ambiguous characters.
-- 32^6 = 1,073,741,824 codes.
create table public.study_groups (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles (id) on delete cascade,
  name text not null
    check (char_length(btrim(name)) between 1 and 80),
  -- Generated codes are always canonical uppercase Crockford. Crockford's
  -- aliasing rules (O reads as 0, I and L as 1, U as V) are not implemented:
  -- accepting them would widen the set of strings that resolve to a real group
  -- by ~1.8x, and every one of those is another guess for someone enumerating
  -- codes. The app upper-cases input before it gets here.
  invite_code text not null unique
    check (invite_code ~ '^[0-9A-HJKMNP-TV-Z]{6}$'),
  invite_code_rotated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

comment on table public.study_groups is
  'Invite-only study group. Reachable only by its members or by exact invite code; no public directory.';

create table public.study_group_members (
  group_id uuid not null references public.study_groups (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  role public.study_group_role not null default 'member',
  joined_at timestamptz not null default now(),
  primary key (group_id, user_id)
);

comment on table public.study_group_members is
  'Group roster. Exactly one row per group carries role=owner, and it is the group owner.';

-- Every RLS policy below, and both helpers, ask "is this user in this group".
-- Without this index each of those is a sequential scan of the whole roster.
create index study_group_members_user_id_idx
  on public.study_group_members (user_id);

-- -----------------------------------------------------------------------------
-- invite codes
-- -----------------------------------------------------------------------------

-- security definer because the uniqueness probe must see every group, including
-- ones the caller is not a member of; without it RLS would hide colliding codes
-- and hand out a duplicate.
create or replace function public.generate_study_group_invite_code()
returns text
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  alphabet constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  candidate text;
  attempts integer := 0;
begin
  loop
    candidate := '';
    for i in 1..6 loop
      candidate := candidate || substr(alphabet, 1 + floor(random() * 32)::int, 1);
    end loop;

    attempts := attempts + 1;

    exit when not exists (
      select 1 from public.study_groups where invite_code = candidate
    );

    -- A collision is a one-in-a-billion event; this bound exists so a caller
    -- cannot spin the loop forever if the table is ever pathologically full.
    if attempts >= 100 then
      raise exception 'could not allocate a unique study group invite code';
    end if;
  end loop;

  return candidate;
end;
$$;

comment on function public.generate_study_group_invite_code() is
  'Six canonical Crockford base32 characters, unique across study_groups.';

-- -----------------------------------------------------------------------------
-- roster invariants
-- -----------------------------------------------------------------------------

-- The cap counts every roster row, the owner included, so a group tops out at
-- twelve people rather than twelve guests plus a host.
--
-- security definer is load-bearing here: the count runs inside an RLS-protected
-- table, and without the definer rights a caller would only ever see the rows
-- they are already allowed to see and the cap would never trip.
create or replace function public.study_group_guard_member_cap()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  roster_size integer;
begin
  -- Two people tapping Join at the same instant would otherwise both read 11 and
  -- both insert. The lock is transaction-scoped, so it is released on commit or
  -- rollback without a session or a retry loop.
  perform pg_advisory_xact_lock(hashtextextended(new.group_id::text, 0));

  select count(*) into roster_size
    from public.study_group_members
   where group_id = new.group_id;

  if roster_size >= 12 then
    raise exception 'this study group is full (12 members, the owner included)';
  end if;

  return new;
end;
$$;

comment on function public.study_group_guard_member_cap() is
  'Caps a group at 12 roster rows, owner included, under a transaction-scoped advisory lock.';

-- Keeps the one-owner invariant true no matter which path wrote the row: an
-- owner row must name the group owner, and the group owner's own row cannot be
-- deleted or repointed.
--
-- No `for update` on the group here on purpose. The cap trigger already
-- serialises roster writes for a group with an advisory lock, and a second lock
-- taken in a different order by a different caller (join_study_group holds the
-- group row first, then the cap takes the advisory lock) is a deadlock waiting
-- for two simultaneous joins. owner_id is immutable anyway, so nothing here can
-- read a stale value.
create or replace function public.study_group_guard_owner_row()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  group_owner uuid;
begin
  if tg_op = 'DELETE' then
    -- Deleting the group cascades into this table, and by the time the child
    -- rows go the parent is already gone. That is a group deletion, not a
    -- member walking out, so let it through.
    if not exists (
      select 1 from public.study_groups where id = old.group_id
    ) then
      return old;
    end if;

    if old.role = 'owner' then
      raise exception 'the group owner cannot leave; delete the group instead';
    end if;

    return old;
  end if;

  select owner_id into group_owner
    from public.study_groups
   where id = new.group_id;

  if group_owner is null then
    raise exception 'study group % does not exist', new.group_id;
  end if;

  if new.role = 'owner' and new.user_id <> group_owner then
    raise exception 'only the group owner can hold the owner role';
  end if;

  return new;
end;
$$;

comment on function public.study_group_guard_owner_row() is
  'The owner roster row must name the group owner, and cannot be deleted or repointed.';

create trigger study_group_members_guard_cap
  before insert on public.study_group_members
  for each row execute function public.study_group_guard_member_cap();

create trigger study_group_members_guard_owner_row
  before insert or update or delete on public.study_group_members
  for each row execute function public.study_group_guard_owner_row();

-- -----------------------------------------------------------------------------
-- RPCs
-- -----------------------------------------------------------------------------

-- Creation is a function, not an insert policy, for one reason: a group without
-- its owner's roster row would be invisible to its own owner, since every read
-- policy goes through membership. Doing both in one transaction is the only way
-- to guarantee the pair exists.
--
-- The client supplies p_group_id so a retry after a timeout returns the same
-- group instead of creating a second one.
create or replace function public.create_study_group(
  p_group_id uuid,
  p_name text
)
returns public.study_groups
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid := auth.uid();
  created public.study_groups;
  existing public.study_groups;
begin
  if v_owner is null then
    raise exception 'not authenticated';
  end if;

  select * into existing from public.study_groups where id = p_group_id;

  if existing.id is not null then
    if existing.owner_id <> v_owner then
      raise exception 'group id already in use';
    end if;
    return existing;
  end if;

  insert into public.study_groups (id, owner_id, name, invite_code)
  values (p_group_id, v_owner, btrim(p_name), public.generate_study_group_invite_code())
  returning * into created;

  insert into public.study_group_members (group_id, user_id, role)
  values (created.id, v_owner, 'owner');

  return created;
end;
$$;

comment on function public.create_study_group(uuid, text) is
  'Creates a group and its owner roster row in one transaction. Idempotent on p_group_id.';

-- Rotating hands out a new code and leaves the old one dead, which is the only
-- remedy if a code leaks. There is no way to recover a rotated-away code, by
-- design.
create or replace function public.rotate_study_group_invite_code(p_group_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid := auth.uid();
  fresh_code text;
begin
  if v_owner is null then
    raise exception 'not authenticated';
  end if;

  perform 1
    from public.study_groups
   where id = p_group_id and owner_id = v_owner
   for update;

  if not found then
    raise exception 'only the owner of study group % can rotate its invite code', p_group_id;
  end if;

  fresh_code := public.generate_study_group_invite_code();

  update public.study_groups
     set invite_code = fresh_code,
         invite_code_rotated_at = now()
   where id = p_group_id;

  return fresh_code;
end;
$$;

comment on function public.rotate_study_group_invite_code(uuid) is
  'Owner-only: issues a new invite code and stamps invite_code_rotated_at.';

-- The one door in. Returns only what a prospective member needs to decide, and
-- nothing about the roster or the owner.
create or replace function public.study_group_from_invite_code(p_code text)
returns table (id uuid, name text, member_count integer, full boolean)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  candidate text := upper(btrim(p_code));
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  if candidate !~ '^[0-9A-HJKMNP-TV-Z]{6}$' then
    raise exception 'invite codes are six Crockford base32 characters';
  end if;

  return query
    select g.id,
           g.name,
           (select count(*)::integer from public.study_group_members m where m.group_id = g.id),
           (select count(*) >= 12 from public.study_group_members m where m.group_id = g.id)
      from public.study_groups g
     where g.invite_code = candidate;
end;
$$;

comment on function public.study_group_from_invite_code(text) is
  'Resolves an invite code to a group preview. The only non-member read path in the schema.';

-- Joining by code. The cap is enforced by the trigger, so this does not
-- reimplement it; it only has to notice that you are already in before the
-- trigger counts, or a re-join into a full group would fail on a row that was
-- never going to be inserted.
create or replace function public.join_study_group(p_code text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  target public.study_groups;
  already_a_member boolean;
begin
  if v_user is null then
    raise exception 'not authenticated';
  end if;

  select * into target
    from public.study_groups
   where invite_code = upper(btrim(p_code))
   for update;

  if target.id is null then
    raise exception 'no study group matches that invite code';
  end if;

  select exists (
    select 1 from public.study_group_members
     where group_id = target.id and user_id = v_user
  ) into already_a_member;

  if already_a_member then
    return target.id;
  end if;

  insert into public.study_group_members (group_id, user_id, role)
  values (target.id, v_user, 'member');

  return target.id;
end;
$$;

comment on function public.join_study_group(text) is
  'Joins the caller to the group named by an invite code. Idempotent; a full group raises.';

-- Bringing someone in by hand, for a member who does not want to pass the code
-- around. The membership check here duplicates the insert policy on purpose:
-- this function is security definer, so RLS is not what stops a non-member, and
-- the policy alone would be a false sense of safety.
create or replace function public.add_study_group_member(
  p_group_id uuid,
  p_user_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  if not public.is_study_group_member(p_group_id, auth.uid()) then
    raise exception 'only a member of study group % can add someone to it', p_group_id;
  end if;

  if not exists (select 1 from public.profiles where id = p_user_id) then
    raise exception 'no such user';
  end if;

  -- A re-add is a no-op. The cap trigger counts before the conflict is
  -- resolved, so a duplicate add into a full group would otherwise raise
  -- "full" for a row that was never going to land.
  if exists (
    select 1 from public.study_group_members
     where group_id = p_group_id and user_id = p_user_id
  ) then
    return p_group_id;
  end if;

  insert into public.study_group_members (group_id, user_id, role)
  values (p_group_id, p_user_id, 'member');

  return p_group_id;
end;
$$;

comment on function public.add_study_group_member(uuid, uuid) is
  'Adds an existing user to a group the caller already belongs to. Owner role cannot be granted.';

-- -----------------------------------------------------------------------------
-- RLS
-- -----------------------------------------------------------------------------

-- Same recursion trap as 0009: a policy on study_group_members cannot
-- sub-select study_group_members, so membership resolves through security
-- definer helpers with a pinned search_path, mirroring public.is_course_owner
-- from 0003.
create or replace function public.is_study_group_member(
  p_group_id uuid,
  p_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.study_group_members m
     where m.group_id = p_group_id and m.user_id = p_user_id
  );
$$;

create or replace function public.is_study_group_owner(
  p_group_id uuid,
  p_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.study_groups g
     where g.id = p_group_id and g.owner_id = p_user_id
  );
$$;

comment on function public.is_study_group_member(uuid, uuid) is
  'RLS helper: true for any member of the group, the owner included.';
comment on function public.is_study_group_owner(uuid, uuid) is
  'RLS helper: true for the group owner.';

alter table public.study_groups enable row level security;
alter table public.study_group_members enable row level security;

-- Members read the group they are in. The owner is a member by construction, so
-- one predicate covers both.
create policy "study_groups_select_member" on public.study_groups
  for select to authenticated
  using (public.is_study_group_member(id, auth.uid()));

-- The `with check` pins owner_id to the caller, which is what makes ownership
-- non-transferable by update: there is no "transfer to" path here by accident.
create policy "study_groups_update_owner" on public.study_groups
  for update to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

create policy "study_groups_delete_owner" on public.study_groups
  for delete to authenticated
  using (owner_id = auth.uid());

-- No insert policy: creation goes through public.create_study_group, which
-- writes the owner roster row in the same transaction. An insert policy here
-- would permit a group with no owner, which no one could then read.

-- The roster is visible to the group's own members, so someone can see who they
-- are studying with. A non-member sees nothing, and learns nothing.
create policy "study_group_members_select_member" on public.study_group_members
  for select to authenticated
  using (public.is_study_group_member(group_id, auth.uid()));

-- Any member may bring someone in; that is the point of a study group. The
-- owner-role forgery is blocked by study_group_guard_owner_row.
create policy "study_group_members_insert_member" on public.study_group_members
  for insert to authenticated
  with check (public.is_study_group_member(group_id, auth.uid()));

-- Leaving is always allowed, so nobody is stuck in a group. Removing somebody
-- else is the owner's call, and the owner's own row is protected by the trigger
-- above.
create policy "study_group_members_delete_self_or_owner" on public.study_group_members
  for delete to authenticated
  using (user_id = auth.uid() or public.is_study_group_owner(group_id, auth.uid()));

-- No update policy on the roster on purpose: a role is fixed at join time.
-- Changing one means removing the row and adding it again, which keeps
-- "promote to owner" from silently rewriting the group's owner_id.

-- -----------------------------------------------------------------------------
-- grants
--
-- Scoped by name, for the reason spelled out at the end of 0010: a blanket
-- revoke would strip the RPCs from the earlier migrations along with these.
-- Nothing in this file is meant to be called directly by a client: the two
-- membership helpers answer policy predicates, the code generator is only ever
-- called from inside another definer function, and the two trigger functions
-- return `trigger` and cannot be invoked at all. Revoking them by name keeps the
-- surface explicit rather than relying on that last accident.
-- -----------------------------------------------------------------------------

revoke execute on function
  public.generate_study_group_invite_code(),
  public.study_group_guard_member_cap(),
  public.study_group_guard_owner_row(),
  public.is_study_group_member(uuid, uuid),
  public.is_study_group_owner(uuid, uuid)
from public, anon, authenticated;

grant execute on function
  public.create_study_group(uuid, text),
  public.rotate_study_group_invite_code(uuid),
  public.study_group_from_invite_code(text),
  public.join_study_group(text),
  public.add_study_group_member(uuid, uuid)
to authenticated;

-- Reads are granted on the tables so members can list their groups and rosters.
-- Writes are revoked outright rather than left to RLS alone: every mutation here
-- is supposed to go through an RPC, and a table grant that outlives a policy
-- change is how the 12-member cap gets bypassed.
grant select on public.study_groups to authenticated;
grant select on public.study_group_members to authenticated;

revoke insert, update, delete on public.study_groups from anon, authenticated;
revoke insert, update, delete on public.study_group_members from anon, authenticated;
