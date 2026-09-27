-- G3: study group invite-flow tests. `pnpm db:tests` chains this file right
-- after supabase/tests/rls_tests.sql in the same psql session: the
-- test_helpers schema (login/logout/expect) and users a and b come from there.
-- This file adds user c, its own groups, and the 0012 surface.
--
-- Covers the three rules G3 named explicitly, plus the rest of the contract:
--   * a non-member can read neither the roster nor the activity ledger,
--   * a removed member loses access immediately (same session, no re-login),
--   * a rotated-away code no longer redeems,
--   * redeeming is idempotent and full groups reject joins,
--   * remove/rotate/transfer are owner-only, and the last owner is stuck
--     until they transfer.
--
-- Expected rejections use the sentinel pattern (flip a flag in the handler,
-- assert outside) rather than expect(false, ...) inside the block: expect()
-- raises the same SQLSTATE as the functions under test, so a handler on
-- raise_exception would otherwise swallow a genuine FAIL into a false PASS.

\set user_c '33333333-3333-3333-3333-333333333333'

-- rls_tests.sql ends logged out; return to the superuser before building
-- fixtures, or the inserts below would run as anon.
reset role;

do $$
declare
  a uuid := '11111111-1111-1111-1111-111111111111';
  b uuid := '22222222-2222-2222-2222-222222222222';
  c uuid := '33333333-3333-3333-3333-333333333333';
  g_main uuid := 'cccccccc-0000-0000-0000-00000000c001';
  g_full uuid := 'cccccccc-0000-0000-0000-00000000c002';
  v_full_code text;
  v_new_code text;
  v_id uuid;
  v_owner_id uuid;
  v_flag boolean;
  v_failed boolean;
  visible int;
  i int;
  filler uuid;
begin
  -- ===== fixtures (as postgres: superuser bypasses RLS, not the triggers) =====

  insert into auth.users (instance_id, id, aud, role, email, email_confirmed_at, created_at, updated_at)
  values ('00000000-0000-0000-0000-000000000000', c, 'authenticated', 'authenticated', 'c@t.test', now(), now(), now())
  on conflict (id) do nothing;

  insert into public.profiles (id, timezone) values (c, 'UTC')
  on conflict (id) do nothing;

  -- Fresh groups every run: deleting the group cascades the roster and the
  -- ledger, so re-runs do not inherit members from a previous pass.
  delete from public.study_groups where id in (g_main, g_full);

  insert into public.study_groups (id, owner_id, name, invite_code)
  values (g_main, a, 'G3 Main Group', 'G3TEST');

  insert into public.study_group_members (group_id, user_id, role)
  values (g_main, a, 'owner'), (g_main, b, 'member');

  -- One ledger row to hide, so the non-member read test proves invisibility
  -- rather than emptiness.
  insert into public.study_group_activity (group_id, actor_id, kind)
  values (g_main, b, 'joined');

  -- A second group, filled to the 12-row cap by deterministic filler users.
  insert into public.study_groups (id, owner_id, name, invite_code)
  values (g_full, a, 'G3 Full Group', public.generate_study_group_invite_code())
  returning invite_code into v_full_code;

  insert into public.study_group_members (group_id, user_id, role)
  values (g_full, a, 'owner');

  for i in 1..11 loop
    filler := ('44444444-0000-0000-0000-0000000044' || lpad(i::text, 2, '0'))::uuid;
    insert into auth.users (instance_id, id, aud, role, email, email_confirmed_at, created_at, updated_at)
    values ('00000000-0000-0000-0000-000000000000', filler, 'authenticated', 'authenticated', 'g3filler' || i::text || '@t.test', now(), now(), now())
    on conflict (id) do nothing;
    insert into public.profiles (id, timezone) values (filler, 'UTC')
    on conflict (id) do nothing;
    insert into public.study_group_members (group_id, user_id, role)
    values (g_full, filler, 'member');
  end loop;

  -- ===== the invite-code preview: the only non-member read path =====

  perform test_helpers.login(c);

  select member_count into visible from public.study_group_from_invite_code(v_full_code);
  perform test_helpers.expect(visible = 12, 'invite-code preview reports the roster size');

  select "full" into v_flag from public.study_group_from_invite_code(v_full_code);
  perform test_helpers.expect(v_flag, 'invite-code preview flags a full group');

  v_failed := false;
  begin
    perform public.study_group_from_invite_code('SHORT');
  exception when raise_exception then
    v_failed := true;
  end;
  perform test_helpers.expect(v_failed, 'invite-code preview rejects a malformed code');

  -- ===== non-members cannot read members or activity =====

  select count(*) into visible from public.study_groups where id = g_main;
  perform test_helpers.expect(visible = 0, 'a non-member cannot see the group');

  select count(*) into visible from public.study_group_members where group_id = g_main;
  perform test_helpers.expect(visible = 0, 'a non-member cannot read the roster');

  select count(*) into visible from public.study_group_activity where group_id = g_main;
  perform test_helpers.expect(visible = 0, 'a non-member cannot read the activity ledger');

  select count(*) into visible from public.profiles where id = a;
  perform test_helpers.expect(visible = 0, 'a non-member cannot read a member''s profile');

  -- ===== redeem_invite_code: join, ledger entry, idempotency =====

  select public.redeem_invite_code('g3test') into v_id;
  perform test_helpers.expect(v_id = g_main, 'redeem returns the group id (lowercase input normalised)');

  select count(*) into visible from public.study_group_members where group_id = g_main;
  perform test_helpers.expect(visible = 3, 'a redeemed member sees the whole roster');

  select count(*) into visible from public.study_group_activity
   where group_id = g_main and actor_id = c and kind = 'joined';
  perform test_helpers.expect(visible = 1, 'a fresh join writes exactly one ledger row');

  select count(*) into visible from public.study_group_activity where group_id = g_main;
  perform test_helpers.expect(visible = 2, 'the ledger is readable once a member');

  select count(*) into visible from public.profiles where id = a;
  perform test_helpers.expect(visible = 1, 'group peers can read each other''s profiles');

  -- Redeeming again is a no-op: same id, no duplicate row, no second entry.
  select public.redeem_invite_code('G3TEST') into v_id;
  perform test_helpers.expect(v_id = g_main, 'a second redeem returns the same group id');

  select count(*) into visible from public.study_group_members where group_id = g_main;
  perform test_helpers.expect(visible = 3, 'a second redeem does not duplicate the roster row');

  select count(*) into visible from public.study_group_activity
   where group_id = g_main and actor_id = c and kind = 'joined';
  perform test_helpers.expect(visible = 1, 'a second redeem writes no second ledger row');

  -- ===== full groups reject joins =====

  v_failed := false;
  begin
    perform public.redeem_invite_code(v_full_code);
  exception when raise_exception then
    v_failed := true;
  end;
  perform test_helpers.expect(v_failed, 'redeeming into a full group is rejected');

  -- ===== the ledger and the roster are RPC-only writes =====

  perform test_helpers.login(b);

  v_failed := false;
  begin
    insert into public.study_group_activity (group_id, actor_id, kind)
    values (g_main, b, 'joined');
  exception when insufficient_privilege then
    v_failed := true;
  end;
  perform test_helpers.expect(v_failed, 'a member cannot write the activity ledger directly');

  v_failed := false;
  begin
    delete from public.study_group_members where group_id = g_main and user_id = c;
  exception when insufficient_privilege then
    v_failed := true;
  end;
  perform test_helpers.expect(v_failed, 'a member cannot remove a roster row directly');

  -- ===== remove_member: owner-only, last-owner guard, immediate loss of access =====

  v_failed := false;
  begin
    perform public.remove_member(g_main, c);
  exception when raise_exception then
    v_failed := true;
  end;
  perform test_helpers.expect(v_failed, 'a non-owner cannot remove a member');

  perform test_helpers.login(a);

  v_failed := false;
  begin
    perform public.remove_member(g_main, a);
  exception when raise_exception then
    v_failed := true;
  end;
  perform test_helpers.expect(v_failed, 'the owner cannot remove themselves (the last owner)');

  perform public.remove_member(g_main, c);

  select count(*) into visible from public.study_group_members where group_id = g_main;
  perform test_helpers.expect(visible = 2, 'the removed member is gone from the roster');

  select count(*) into visible from public.study_group_activity
   where group_id = g_main and kind = 'removed' and actor_id = a
     and detail ->> 'user_id' = c::text;
  perform test_helpers.expect(visible = 1, 'the removal is recorded in the ledger');

  -- Removed loses access immediately: same session, no re-login.
  perform test_helpers.login(c);

  select count(*) into visible from public.study_group_members where group_id = g_main;
  perform test_helpers.expect(visible = 0, 'a removed member can no longer read the roster');

  select count(*) into visible from public.study_group_activity where group_id = g_main;
  perform test_helpers.expect(visible = 0, 'a removed member can no longer read the ledger');

  select count(*) into visible from public.study_groups where id = g_main;
  perform test_helpers.expect(visible = 0, 'a removed member can no longer see the group');

  v_failed := false;
  begin
    perform public.leave_group(g_main);
  exception when raise_exception then
    v_failed := true;
  end;
  perform test_helpers.expect(v_failed, 'a removed member cannot leave again');

  -- ===== leave_group =====

  perform test_helpers.login(b);

  perform public.leave_group(g_main);

  perform test_helpers.login(a);

  select count(*) into visible from public.study_group_members where group_id = g_main;
  perform test_helpers.expect(visible = 1, 'a member who leaves is gone from the roster');

  select count(*) into visible from public.study_group_activity
   where group_id = g_main and kind = 'left' and actor_id = b;
  perform test_helpers.expect(visible = 1, 'leaving is recorded in the ledger');

  -- ===== transfer_owner: ownership really moves =====

  perform test_helpers.login(b);

  v_failed := false;
  begin
    perform public.transfer_owner(g_main, b);
  exception when raise_exception then
    v_failed := true;
  end;
  perform test_helpers.expect(v_failed, 'a non-owner cannot transfer the group');

  -- b rejoins through the still-valid code; the transfer tests need a member.
  select public.redeem_invite_code('g3test') into v_id;
  perform test_helpers.expect(v_id = g_main, 'a former member can rejoin through the code');

  v_failed := false;
  begin
    perform public.transfer_owner(g_main, b);
  exception when raise_exception then
    v_failed := true;
  end;
  perform test_helpers.expect(v_failed, 'a plain member cannot take ownership');

  perform test_helpers.login(a);

  v_failed := false;
  begin
    perform public.transfer_owner(g_main, c);
  exception when raise_exception then
    v_failed := true;
  end;
  perform test_helpers.expect(v_failed, 'ownership cannot be transferred to a non-member');

  v_failed := false;
  begin
    perform public.transfer_owner(g_main, a);
  exception when raise_exception then
    v_failed := true;
  end;
  perform test_helpers.expect(v_failed, 'ownership cannot be transferred to the current owner');

  perform public.transfer_owner(g_main, b);

  select owner_id into v_owner_id from public.study_groups where id = g_main;
  perform test_helpers.expect(v_owner_id = b, 'the group now names the new owner');

  select count(*) into visible from public.study_group_members
   where group_id = g_main and role = 'owner';
  perform test_helpers.expect(visible = 1, 'exactly one owner row remains after a transfer');

  select count(*) into visible from public.study_group_members
   where group_id = g_main and user_id = b and role = 'owner';
  perform test_helpers.expect(visible = 1, 'the new owner holds the owner role');

  select count(*) into visible from public.study_group_activity
   where group_id = g_main and kind = 'transferred' and actor_id = a
     and detail ->> 'to_user_id' = b::text;
  perform test_helpers.expect(visible = 1, 'the transfer is recorded in the ledger');

  -- The demoted owner is now an ordinary member: locked out of owner actions,
  -- free to leave.
  v_failed := false;
  begin
    perform public.rotate_invite_code(g_main);
  exception when raise_exception then
    v_failed := true;
  end;
  perform test_helpers.expect(v_failed, 'a demoted owner can no longer rotate the code');

  perform public.leave_group(g_main);

  perform test_helpers.login(b);

  select count(*) into visible from public.study_group_members where group_id = g_main;
  perform test_helpers.expect(visible = 1, 'the demoted owner can leave after transferring');

  select count(*) into visible from public.study_group_activity
   where group_id = g_main and kind = 'left' and actor_id = a;
  perform test_helpers.expect(visible = 1, 'the demoted owner''s exit is recorded in the ledger');

  -- ===== rotate_invite_code: an old rotated code fails =====

  select public.rotate_invite_code(g_main) into v_new_code;
  perform test_helpers.expect(v_new_code <> 'G3TEST', 'rotation issues a different code');

  select count(*) into visible from public.study_groups
   where id = g_main and invite_code = v_new_code;
  perform test_helpers.expect(visible = 1, 'the fresh code is the group''s current code');

  select count(*) into visible from public.study_group_activity
   where group_id = g_main and kind = 'code_rotated' and actor_id = b;
  perform test_helpers.expect(visible = 1, 'the rotation is recorded in the ledger');

  perform test_helpers.login(c);

  v_failed := false;
  begin
    perform public.redeem_invite_code('g3test');
  exception when raise_exception then
    v_failed := true;
  end;
  perform test_helpers.expect(v_failed, 'an old rotated code no longer redeems');

  select count(*) into visible from public.study_group_from_invite_code('G3TEST');
  perform test_helpers.expect(visible = 0, 'an old rotated code previews nothing');

  select public.redeem_invite_code(v_new_code) into v_id;
  perform test_helpers.expect(v_id = g_main, 'the fresh code still redeems');

  perform test_helpers.logout();

  raise notice 'ALL GROUP TESTS PASSED';
end;
$$;
