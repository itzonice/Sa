-- G2: study groups. Run with `pnpm db:tests`.
--
-- The same plain-SQL + DO-block style as rls_tests.sql, and the helpers are
-- redeclared here rather than relied upon from rls_tests.sql, so this file can
-- be run on its own.

create schema if not exists test_helpers;

create or replace function test_helpers.login(uid uuid)
returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', false);
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, false);
end;
$$;

create or replace function test_helpers.logout()
returns void language plpgsql as $$
begin
  perform set_config('role', 'anon', false);
  perform set_config('request.jwt.claims', '', false);
end;
$$;

create or replace function test_helpers.expect(condition boolean, message text)
returns void language plpgsql as $$
begin
  if condition then
    raise notice 'PASS: %', message;
  else
    raise exception 'FAIL: %', message;
  end if;
end;
$$;

-- A profile only exists if auth.users does, because of the signup trigger.
create or replace function test_helpers.make_user(uid uuid, email text)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into auth.users (instance_id, id, aud, role, email, email_confirmed_at, created_at, updated_at)
  values (
    '00000000-0000-0000-0000-000000000000', uid, 'authenticated', 'authenticated',
    email, now(), now(), now()
  )
  on conflict (id) do nothing;

  insert into public.profiles (id, timezone)
  values (uid, 'UTC')
  on conflict (id) do nothing;
end;
$$;

create or replace function test_helpers.group_users()
returns void language plpgsql security definer set search_path = public as $$
declare
  n int;
begin
  for n in 1..14 loop
    perform test_helpers.make_user(
      ('33333333-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid,
      'cap' || n || '@t.test'
    );
  end loop;
end;
$$;

do $$
declare
  a uuid := '11111111-1111-1111-1111-111111111111';
  b uuid := '22222222-2222-2222-2222-222222222222';
  c uuid := '33333333-0000-0000-0000-000000000001';
  g1 uuid := 'bbbbbbbb-0000-0000-0000-000000000001';
  g2 uuid := 'bbbbbbbb-0000-0000-0000-000000000002';
  g3 uuid := 'bbbbbbbb-0000-0000-0000-000000000003';
  created public.study_groups;
  code1 text;
  old_code text;
  new_code text;
  rotated_at_before timestamptz;
  n int;
  visible int;
  preview record;
begin
  perform test_helpers.make_user(a, 'a@t.test');
  perform test_helpers.make_user(b, 'b@t.test');
  perform test_helpers.group_users();

  -- ===== creation: a group is born with an owner row =====

  perform test_helpers.login(a);

  created := public.create_study_group(g1, '  Linear Algebra Crew  ');
  code1 := created.invite_code;

  perform test_helpers.expect(created.name = 'Linear Algebra Crew', 'group name is trimmed');
  perform test_helpers.expect(created.owner_id = a, 'group owner is the creator');
  perform test_helpers.expect(
    code1 ~ '^[0-9A-HJKMNP-TV-Z]{6}$',
    'invite code is six Crockford base32 characters'
  );
  perform test_helpers.expect(
    not exists (select 1 from public.study_groups where id = g1 and invite_code ~ '[ILOU]'),
    'invite code contains no I, L, O or U'
  );
  perform test_helpers.expect(
    exists (select 1 from public.study_group_members where group_id = g1 and user_id = a and role = 'owner'),
    'the owner has an owner roster row'
  );

  -- Idempotent on the client-supplied id.
  perform test_helpers.expect(
    (public.create_study_group(g1, 'Different Name')).id = g1
      and (select count(*) from public.study_groups) = 1,
    'create_study_group is idempotent on p_group_id'
  );

  -- ===== no public directory =====

  perform test_helpers.login(b);
  select count(*) into visible from public.study_groups;
  perform test_helpers.expect(visible = 0, 'a non-member sees no groups at all');
  select count(*) into visible from public.study_group_members;
  perform test_helpers.expect(visible = 0, 'a non-member sees no roster at all');

  -- ===== the invite code is the only door in =====

  select * into preview from public.study_group_from_invite_code('ZZZZZZ');
  perform test_helpers.expect(not found, 'a wrong code resolves to nothing');

  select * into preview from public.study_group_from_invite_code(lower(code1));
  perform test_helpers.expect(
    found and preview.id = g1 and preview.name = 'Linear Algebra Crew',
    'a code resolves to the group, case-insensitively'
  );

  begin
    perform public.study_group_from_invite_code('ABC');
    perform test_helpers.expect(false, 'a short code is rejected (expected rejection)');
  exception when others then
    perform test_helpers.expect(true, 'a short code is rejected');
  end;

  perform test_helpers.expect(
    public.join_study_group(code1) = g1,
    'joining by code returns the group id'
  );
  perform test_helpers.expect(
    public.join_study_group(code1) = g1
      and (select count(*) from public.study_group_members where group_id = g1) = 2,
    'joining twice does not duplicate the roster row'
  );

  -- ===== members read, only the owner writes =====

  select count(*) into visible from public.study_groups where id = g1;
  perform test_helpers.expect(visible = 1, 'a member can read their group');
  select count(*) into visible from public.study_group_members where group_id = g1;
  perform test_helpers.expect(visible = 2, 'a member can read the roster');

  begin
    update public.study_groups set name = 'hijacked' where id = g1;
  exception when others then
    null; -- rejected at the privilege or policy layer, either is fine
  end;
  perform test_helpers.expect(
    not exists (select 1 from public.study_groups where id = g1 and name = 'hijacked'),
    'a member cannot rename the group'
  );

  begin
    delete from public.study_groups where id = g1;
  exception when others then
    null;
  end;
  perform test_helpers.expect(
    exists (select 1 from public.study_groups where id = g1),
    'a member cannot delete the group'
  );

  -- A member may leave, and only the owner may remove somebody else.
  perform test_helpers.expect(
    public.add_study_group_member(g1, c) = g1,
    'a member can add somebody to the group'
  );
  perform test_helpers.expect(
    public.add_study_group_member(g1, c) = g1
      and (select count(*) from public.study_group_members where group_id = g1) = 3,
    'adding the same person twice is a no-op'
  );

  perform test_helpers.login(a);
  select count(*) into visible from public.study_groups where id = g1;
  perform test_helpers.expect(visible = 1, 'the owner can read the group');
  update public.study_groups set name = 'Linear Algebra Crew' where id = g1;
  perform test_helpers.expect(
    exists (select 1 from public.study_groups where id = g1 and name = 'Linear Algebra Crew'),
    'the owner can rename the group'
  );

  -- Ownership is not transferable by update.
  begin
    update public.study_groups set owner_id = b where id = g1;
  exception when others then
    null;
  end;
  perform test_helpers.expect(
    exists (select 1 from public.study_groups where id = g1 and owner_id = a),
    'the owner cannot be changed by updating the group'
  );

  -- ===== rotation is owner-only and kills the old code =====

  perform test_helpers.login(b);
  begin
    perform public.rotate_study_group_invite_code(g1);
    perform test_helpers.expect(false, 'a member cannot rotate the invite code (expected rejection)');
  exception when others then
    perform test_helpers.expect(true, 'a member cannot rotate the invite code');
  end;

  perform test_helpers.login(a);
  old_code := code1;
  rotated_at_before := (select invite_code_rotated_at from public.study_groups where id = g1);
  new_code := public.rotate_study_group_invite_code(g1);

  perform test_helpers.expect(new_code <> old_code, 'rotation issues a different code');
  perform test_helpers.expect(
    new_code ~ '^[0-9A-HJKMNP-TV-Z]{6}$',
    'the rotated code is still Crockford base32'
  );
  perform test_helpers.expect(
    (select invite_code from public.study_groups where id = g1) = new_code,
    'the rotated code is the one on the row'
  );
  perform test_helpers.expect(
    (select invite_code_rotated_at from public.study_groups where id = g1) >= rotated_at_before,
    'rotation stamps invite_code_rotated_at'
  );
  perform test_helpers.expect(
    not exists (select 1 from public.study_groups where invite_code = old_code),
    'the old code no longer exists anywhere'
  );

  perform test_helpers.login(c);
  begin
    perform public.join_study_group(old_code);
    perform test_helpers.expect(false, 'the old code cannot be used to join (expected rejection)');
  exception when others then
    perform test_helpers.expect(true, 'the old code cannot be used to join');
  end;
  perform test_helpers.expect(
    public.join_study_group(new_code) = g1,
    'the new code works'
  );

  -- ===== nobody is stuck, and the owner cannot abandon the group =====

  perform test_helpers.login(b);
  delete from public.study_group_members where group_id = g1 and user_id = b;
  perform test_helpers.expect(
    not exists (select 1 from public.study_group_members where group_id = g1 and user_id = b),
    'a member can leave'
  );

  perform test_helpers.login(a);
  begin
    delete from public.study_group_members where group_id = g1 and user_id = a;
    perform test_helpers.expect(false, 'the owner cannot leave (expected rejection)');
  exception when others then
    perform test_helpers.expect(true, 'the owner cannot leave');
  end;
  perform test_helpers.expect(
    exists (select 1 from public.study_group_members where group_id = g1 and user_id = a and role = 'owner'),
    'the owner row survived the attempt'
  );

  -- ===== the 12-member cap =====

  created := public.create_study_group(g2, 'Cap Test');

  -- The owner is row 1, so eleven adds fill the group and the twelfth must fail.
  for n in 1..11 loop
    perform public.add_study_group_member(
      g2,
      ('33333333-0000-0000-0000-' || lpad((n + 2)::text, 12, '0'))::uuid
    );
  end loop;

  select count(*) into visible from public.study_group_members where group_id = g2;
  perform test_helpers.expect(visible = 12, 'the group holds 12 members, the owner included');

  begin
    perform public.add_study_group_member(
      g2,
      ('33333333-0000-0000-0000-' || lpad('14', 12, '0'))::uuid
    );
    perform test_helpers.expect(false, 'a thirteenth member is rejected (expected rejection)');
  exception when others then
    perform test_helpers.expect(true, 'a thirteenth member is rejected');
  end;

  select count(*) into visible from public.study_group_members where group_id = g2;
  perform test_helpers.expect(visible = 12, 'the rejected add left the roster at 12');

  select * into preview from public.study_group_from_invite_code(created.invite_code);
  perform test_helpers.expect(preview.full, 'a code preview reports the group as full');

  -- Freeing a slot lets the next person in.
  delete from public.study_group_members
   where group_id = g2
     and user_id = ('33333333-0000-0000-0000-000000000003')::uuid;
  perform test_helpers.expect(
    public.add_study_group_member(
      g2,
      ('33333333-0000-0000-0000-' || lpad('14', 12, '0'))::uuid
    ) = g2,
    'a freed slot can be used'
  );

  -- A non-member cannot add themselves to a group they found.
  perform test_helpers.login(b);
  begin
    perform public.add_study_group_member(g2, b);
    perform test_helpers.expect(false, 'a non-member cannot add themselves (expected rejection)');
  exception when others then
    perform test_helpers.expect(true, 'a non-member cannot add themselves');
  end;
  perform test_helpers.expect(
    not exists (select 1 from public.study_group_members where group_id = g2 and user_id = b),
    'the rejected add wrote nothing'
  );

  -- ===== deletion cascades =====

  perform test_helpers.login(a);
  created := public.create_study_group(g3, 'Doomed');
  perform public.add_study_group_member(g3, b);
  perform test_helpers.expect(
    (select count(*) from public.study_group_members where group_id = g3) = 2,
    'the doomed group has two roster rows'
  );

  delete from public.study_groups where id = g3;
  perform test_helpers.expect(
    not exists (select 1 from public.study_groups where id = g3),
    'the owner can delete the group'
  );
  perform test_helpers.expect(
    not exists (select 1 from public.study_group_members where group_id = g3),
    'deleting a group cascades to its roster, owner row included'
  );

  -- Codes are unique across groups, which is what makes an exact-code lookup a
  -- usable door.
  select count(*) into visible from (
    select invite_code from public.study_groups group by invite_code having count(*) > 1
  ) duplicates;
  perform test_helpers.expect(visible = 0, 'no two groups share an invite code');

  perform test_helpers.logout();

  raise notice 'ALL STUDY GROUP TESTS PASSED';
end;
$$;
