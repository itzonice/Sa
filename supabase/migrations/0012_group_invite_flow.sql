-- G3: the group invite flow -- redeem, leave, remove, rotate, transfer -- and
-- the activity ledger that makes a group's story readable by its members.
--
-- Everything here preserves the two invariants 0011 set up:
--   * a group always has exactly one owner, named by study_groups.owner_id and
--     mirrored by the one role='owner' roster row, and
--   * a group is invisible to anyone who is not in it.
-- The RPCs below are the only sanctioned ways to cross those lines: transfer is
-- a handover, not an update; removal is the owner's call; and the last owner
-- cannot be removed or leave, only replaced.

-- -----------------------------------------------------------------------------
-- activity ledger
-- -----------------------------------------------------------------------------

-- One row per membership event, written only by the RPCs in this file (no
-- insert policy, no direct-write grant). It exists so a member can open a
-- group and see who joined, who left and who is in charge now -- and so the RLS
-- tests can prove that a removed member cannot read even this.
create table public.study_group_activity (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.study_groups (id) on delete cascade,
  -- Nullable on purpose: if a member deletes their account the event remains,
  -- reading "someone left", rather than vanishing with the user.
  actor_id uuid references public.profiles (id) on delete set null,
  kind text not null
    check (kind in ('joined', 'left', 'removed', 'transferred', 'code_rotated')),
  -- 'removed' carries {"user_id": ...}; 'transferred' carries {"to_user_id": ...}.
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

comment on table public.study_group_activity is
  'Membership events for a study group. Written only by RPCs; readable only by members.';

create index study_group_activity_group_id_created_at_idx
  on public.study_group_activity (group_id, created_at);

alter table public.study_group_activity enable row level security;

create policy "study_group_activity_select_member" on public.study_group_activity
  for select to authenticated
  using (public.is_study_group_member(group_id, auth.uid()));

-- No insert/update/delete policies, and the grants below revoke the writes:
-- the ledger records what the RPCs did, and a client writing its own history is
-- exactly the kind of lie RLS exists to prevent.

-- -----------------------------------------------------------------------------
-- profiles: group peers
-- -----------------------------------------------------------------------------

-- The roster on the group page needs names, and 0003's profiles policy is
-- own-row only (widened once already, for live-session buddies, in 0009).
-- Sharing a group is the same kind of narrow, symmetric relationship, so the
-- same shape: a member may read the profile of anyone they share a group with
-- and nobody else. The sub-select runs under the roster's own member-only
-- policy, which is what keeps a stranger from listing members' profiles by
-- guessing group ids.
create policy "profiles_select_group_peers" on public.profiles
  for select to authenticated
  using (
    id in (
      select peer.user_id
        from public.study_group_members mine
        join public.study_group_members peer on peer.group_id = mine.group_id
       where mine.user_id = auth.uid()
    )
  );

-- -----------------------------------------------------------------------------
-- a grant 0011 owed
--
-- 0011 revoked EXECUTE on both of its membership helpers from authenticated
-- along with the internal functions, but both helpers run inside RLS policies
-- (the member select policies, and the self-or-owner delete policy), and policy
-- expressions are evaluated as the querying user: without EXECUTE, every member
-- read of study_groups and study_group_members -- and the two policies above --
-- fails with "permission denied for function". 0010 granted its live-session
-- helpers for exactly this reason; this restores parity for the group ones.
-- -----------------------------------------------------------------------------

grant execute on function
  public.is_study_group_member(uuid, uuid),
  public.is_study_group_owner(uuid, uuid)
to authenticated;

-- -----------------------------------------------------------------------------
-- RPCs
-- -----------------------------------------------------------------------------

-- The canonical way in. Same contract as 0011's join_study_group -- lookup by
-- exact code, membership noticed before the 12-member cap so re-redeeming a
-- full group does not raise -- with one addition: a fresh join is recorded in
-- the ledger. Redeeming as an existing member returns the group id and writes
-- nothing.
create or replace function public.redeem_invite_code(p_code text)
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
    select 1
      from public.study_group_members
     where group_id = target.id and user_id = v_user
  ) into already_a_member;

  -- Checked before the insert, not after: the cap trigger counts roster rows,
  -- and a member redeeming their own group's code a second time must not be
  -- told the group is full.
  if already_a_member then
    return target.id;
  end if;

  -- The 12-member cap is enforced by study_group_guard_member_cap.
  insert into public.study_group_members (group_id, user_id, role)
  values (target.id, v_user, 'member');

  insert into public.study_group_activity (group_id, actor_id, kind)
  values (target.id, v_user, 'joined');

  return target.id;
end;
$$;

comment on function public.redeem_invite_code(text) is
  'Joins the caller to the group named by an invite code and records the join. Idempotent for members; a full group raises.';

-- Walking out is always allowed, except for the one person who cannot: the
-- owner. 0011's trigger already refuses to delete the owner's roster row; the
-- check here exists to say why, in words a member can act on, instead of
-- surfacing the trigger error.
create or replace function public.leave_group(p_group_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  own_row public.study_group_members;
begin
  if v_user is null then
    raise exception 'not authenticated';
  end if;

  select * into own_row
    from public.study_group_members
   where group_id = p_group_id and user_id = v_user
   for update;

  if own_row.user_id is null then
    raise exception 'you are not a member of that study group';
  end if;

  if own_row.role = 'owner' then
    raise exception 'the owner cannot leave; transfer ownership first';
  end if;

  delete from public.study_group_members
   where group_id = p_group_id and user_id = v_user;

  insert into public.study_group_activity (group_id, actor_id, kind)
  values (p_group_id, v_user, 'left');
end;
$$;

comment on function public.leave_group(uuid) is
  'Member exit, recorded in the ledger. The owner must transfer ownership first.';

-- Owner-only, and the owner is exactly who it cannot remove: this model has a
-- single owner at all times, so "the last owner" and "the owner" are the same
-- row, and deleting it would strand the group. Ownership changes hands through
-- transfer_owner or not at all.
create or replace function public.remove_member(p_group_id uuid, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid := auth.uid();
  group_row public.study_groups;
begin
  if v_owner is null then
    raise exception 'not authenticated';
  end if;

  select * into group_row
    from public.study_groups
   where id = p_group_id and owner_id = v_owner
   for update;

  if group_row.id is null then
    raise exception 'only the owner of a study group can remove members';
  end if;

  if p_user_id = group_row.owner_id then
    raise exception 'cannot remove the last owner; transfer ownership first';
  end if;

  if not exists (
    select 1
      from public.study_group_members
     where group_id = p_group_id and user_id = p_user_id
  ) then
    raise exception 'that user is not a member of this study group';
  end if;

  delete from public.study_group_members
   where group_id = p_group_id and user_id = p_user_id;

  insert into public.study_group_activity (group_id, actor_id, kind, detail)
  values (p_group_id, v_owner, 'removed', jsonb_build_object('user_id', p_user_id));
end;
$$;

comment on function public.remove_member(uuid, uuid) is
  'Owner-only removal of another member, recorded in the ledger. The owner row cannot be removed, only transferred.';

-- Thin by design: 0011's rotate_study_group_invite_code already owns the owner
-- check, the row lock and the code generation. This adds the ledger entry --
-- the one event that changes what every other member should do with a code
-- they were handed.
create or replace function public.rotate_invite_code(p_group_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  fresh_code text;
begin
  fresh_code := public.rotate_study_group_invite_code(p_group_id);

  insert into public.study_group_activity (group_id, actor_id, kind)
  values (p_group_id, auth.uid(), 'code_rotated');

  return fresh_code;
end;
$$;

comment on function public.rotate_invite_code(uuid) is
  'Owner-only: issues a new invite code and records the rotation in the ledger.';

-- The sanctioned ownership handover 0011 deliberately left out of its update
-- policy ("no 'transfer to' path here by accident"): the caller hands the group
-- to one of its members and becomes a plain member themselves, after which the
-- new owner can remove them, or they can leave. The three writes are ordered
-- around study_group_guard_owner_row, which requires any role='owner' row to
-- name study_groups.owner_id:
--   1. repoint study_groups.owner_id at the new owner (no roster trigger fires
--      on a groups update),
--   2. demote the old owner's row -- an update that no longer claims 'owner',
--   3. promote the new owner's row, which now names the group owner.
-- Reversing steps 2 and 3 fails: promoting first asks the guard to accept a
-- role='owner' row for someone who is not the group owner yet.
create or replace function public.transfer_owner(p_group_id uuid, p_new_owner uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid := auth.uid();
  group_row public.study_groups;
begin
  if v_owner is null then
    raise exception 'not authenticated';
  end if;

  select * into group_row
    from public.study_groups
   where id = p_group_id and owner_id = v_owner
   for update;

  if group_row.id is null then
    raise exception 'only the owner of a study group can transfer it';
  end if;

  if p_new_owner = v_owner then
    raise exception 'you already own this study group';
  end if;

  if not exists (
    select 1
      from public.study_group_members
     where group_id = p_group_id and user_id = p_new_owner
  ) then
    raise exception 'the new owner must already be a member of this study group';
  end if;

  update public.study_groups
     set owner_id = p_new_owner
   where id = p_group_id;

  update public.study_group_members
     set role = 'member'
   where group_id = p_group_id and user_id = v_owner;

  update public.study_group_members
     set role = 'owner'
   where group_id = p_group_id and user_id = p_new_owner;

  insert into public.study_group_activity (group_id, actor_id, kind, detail)
  values (p_group_id, v_owner, 'transferred', jsonb_build_object('to_user_id', p_new_owner));
end;
$$;

comment on function public.transfer_owner(uuid, uuid) is
  'Hands the group to one of its members; the caller becomes a plain member. Recorded in the ledger.';

-- -----------------------------------------------------------------------------
-- grants
--
-- Same scoping discipline as 0010/0011: named grants for what the client calls,
-- named revokes for what it must not. The ledger is readable by members (the
-- select policy plus the grant below) and writable by no role at all -- only
-- the definer functions above insert into it.
-- -----------------------------------------------------------------------------

grant execute on function
  public.redeem_invite_code(text),
  public.leave_group(uuid),
  public.remove_member(uuid, uuid),
  public.rotate_invite_code(uuid),
  public.transfer_owner(uuid, uuid)
to authenticated;

grant select on public.study_group_activity to authenticated;

revoke insert, update, delete on public.study_group_activity from anon, authenticated;
