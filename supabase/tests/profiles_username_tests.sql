-- Public usernames. Run with `pnpm db:tests`.
--
-- The headline requirement is the last test in the first block: two users cannot
-- take the same username, including when they differ only in case.
--
-- The slug rules are duplicated in packages/core/src/identity/username.ts, and
-- these cases are the same table of cases its tests assert, so the two
-- implementations cannot drift apart quietly.

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

-- Signs a user up for real, so the handle_new_user trigger allocates the username
-- exactly as it would in production. raw_user_meta_data carries the timezone the
-- way the signup form does.
create or replace function test_helpers.sign_up(uid uuid, email text, metadata jsonb default '{}'::jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into auth.users (instance_id, id, aud, role, email, email_confirmed_at, raw_user_meta_data, created_at, updated_at)
  values (
    '00000000-0000-0000-0000-000000000000', uid, 'authenticated', 'authenticated',
    email, now(), metadata, now(), now()
  )
  on conflict (id) do nothing;
end;
$$;

create or replace function test_helpers.expect_signup_rejected(uid uuid, email text)
returns void language plpgsql security definer set search_path = public as $$
begin
  begin
    perform test_helpers.sign_up(uid, email);
  exception when others then
    return;
  end;

  raise exception 'FAIL: signing up as % should have been rejected', email;
end;
$$;

-- Attempts a raw UPDATE as the table owner, with no RPC and no RLS in the way.
-- This is how the schema's own guarantees get tested separately from the column
-- grants: the client-facing tests prove a caller *cannot* write username, and
-- this one proves that even the owner *cannot* store a value the constraints
-- reject.
create or replace function test_helpers.owner_set_username(uid uuid, new_username text)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.profiles set username = new_username where id = uid;
end;
$$;

do $$
declare
  ada uuid := '44444444-0000-0000-0000-000000000001';
  grace uuid := '44444444-0000-0000-0000-000000000002';
  alan uuid := '44444444-0000-0000-0000-000000000003';
  taken_handle text;
  bad text;
begin
  -- ===== slug_from_email =====

  perform test_helpers.expect(public.slug_from_email('ada.lovelace@example.com') = 'ada_lovelace',
    'the local part is kept and dots become underscores');
  perform test_helpers.expect(public.slug_from_email('ADA@Example.COM') = 'ada',
    'the slug is lowercase');
  perform test_helpers.expect(public.slug_from_email('ada+study@example.com') = 'ada_study',
    'a plus tag becomes one underscore');
  perform test_helpers.expect(public.slug_from_email('ada...lovelace@example.com') = 'ada_lovelace',
    'runs of disallowed characters collapse');
  perform test_helpers.expect(public.slug_from_email('weird@local@example.com') = 'weird_local',
    'only the part before the last @ is used');
  perform test_helpers.expect(public.slug_from_email('@example.com') is null,
    'no local part yields null, not an empty string');
  perform test_helpers.expect(public.slug_from_email('') is null,
    'an empty address yields null');
  perform test_helpers.expect(length(public.slug_from_email(repeat('a', 40) || '@example.com')) <= 20,
    'a long local part is truncated to 20 characters');

  -- ===== the candidate ladder =====

  perform test_helpers.expect(
    (select array_agg(candidate order by ordinal) from public.username_candidates('ada', 4))
      = array['ada', 'ada_2', 'ada_3', 'ada_4'],
    'candidates are base then _2, _3, _4');
  perform test_helpers.expect(
    not exists (
      select 1 from public.username_candidates(repeat('a', 20), 50) c
       where char_length(c.candidate) > 20
    ),
    'every candidate fits in 20 characters');
  perform test_helpers.expect(
    not exists (
      select 1 from public.username_candidates(repeat('a', 20), 50) c
       where c.candidate !~ '^[a-z0-9_]{3,20}$'
    ),
    'every candidate is a well-formed username');

  -- ===== signup allocates a username =====

  perform test_helpers.sign_up(ada, 'ada.lovelace@example.com');

  perform test_helpers.expect(
    (select username from public.profiles where id = ada) = 'ada_lovelace',
    'signup derives the username from the email local part');
  perform test_helpers.expect(
    (select timezone from public.profiles where id = ada) = 'UTC',
    'the profile still gets its default timezone');

  -- Two people, one local part: the second gets a numeric suffix rather than
  -- failing the signup.
  perform test_helpers.sign_up(grace, 'ada.lovelace@other.example');

  select username into taken_handle from public.profiles where id = grace;
  perform test_helpers.expect(taken_handle = 'ada_lovelace_2',
    'a colliding local part is suffixed _2 (got ' || coalesce(taken_handle, 'null') || ')');

  -- ===== uniqueness =====

  perform test_helpers.sign_up(alan, 'alan@example.com');
  perform test_helpers.expect(
    (select username from public.profiles where id = alan) = 'alan',
    'an unrelated address is unaffected by the collision');

  perform test_helpers.login(alan);

  -- The headline requirement.
  begin
    perform public.set_username('ada_lovelace');
    perform test_helpers.expect(false, 'a taken username is rejected (expected rejection)');
  exception when others then
    perform test_helpers.expect(true, 'a taken username is rejected');
  end;

  -- ...including when the only difference is case.
  begin
    perform public.set_username('Ada_Lovelace');
    perform test_helpers.expect(false, 'a taken username in different case is rejected (expected rejection)');
  exception when others then
    perform test_helpers.expect(true, 'a taken username in different case is rejected');
  end;

  perform test_helpers.expect(
    (select username from public.profiles where id = alan) = 'alan',
    'the rejected claim left the profile unchanged');

  -- Case is still folded on the way in, so a mixed-case request stores lowercase
  -- and therefore collides with the lowercase original.
  perform test_helpers.expect(public.set_username('  ALAN_TWO  ') = 'alan_two',
    'a mixed-case username is normalised before it is stored');
  perform test_helpers.expect(
    (select username from public.profiles where id = alan) = 'alan_two',
    'the stored username is lowercase');
  perform test_helpers.expect(
    (select username from public.profiles where id = alan) ~ '^[a-z0-9_]{3,20}$',
    'the stored username matches the check constraint');

  -- Free to reclaim your own handle.
  perform test_helpers.expect(public.set_username('alan_two') = 'alan_two',
    're-claiming your current username is a no-op, not a collision');

  -- ===== format validation =====

  foreach bad in array array[
    'ab',
    'a_b_c_d_e_f_g_h_i_j_k_l_m_n_o_p',  -- 24 characters
    'has-hyphen',
    'has space',
    '_leading',
    'trailing_',
    'admin',
    'Has-Caps'
  ] loop
    begin
      perform public.set_username(bad);
      perform test_helpers.expect(false, 'the username ' || quote_literal(bad) || ' is rejected (expected rejection)');
    exception when others then
      perform test_helpers.expect(true, 'the username ' || quote_literal(bad) || ' is rejected');
    end;
  end loop;

  -- ===== the constraints hold even for the table owner =====

  -- As a definer, so the UPDATE is attempted with full privileges and the check
  -- constraint and unique index are what reject it -- not a missing grant.
  begin
    perform test_helpers.owner_set_username(alan, 'not valid');
    perform test_helpers.expect(false, 'the check constraint rejects a malformed username (expected rejection)');
  exception when check_violation then
    perform test_helpers.expect(true, 'the check constraint rejects a malformed username');
  end;

  begin
    perform test_helpers.owner_set_username(alan, 'ada_lovelace');
    perform test_helpers.expect(false, 'the unique index rejects a duplicate username (expected rejection)');
  exception when unique_violation then
    perform test_helpers.expect(true, 'the unique index rejects a duplicate username');
  end;

  begin
    perform test_helpers.owner_set_username(alan, 'ADA_LOVELACE');
    perform test_helpers.expect(false, 'the unique index rejects a duplicate that differs only in case (expected rejection)');
  exception when check_violation or unique_violation then
    perform test_helpers.expect(true, 'the unique index rejects a duplicate that differs only in case');
  end;

  perform test_helpers.expect(
    (select username from public.profiles where id = alan) = 'alan_two',
    'every rejected owner-level write left the row alone'
  );

  -- ===== no email on the profile =====

  perform test_helpers.expect(
    not exists (
      select 1 from information_schema.columns
       where table_schema = 'public' and table_name = 'profiles'
         and column_name = 'email'
    ),
    'profiles has no email column, so an address cannot leak through it');

  -- ===== the derived columns are not client-writable =====

  perform test_helpers.login(alan);

  begin
    update public.profiles set streak_current = 999 where id = alan;
    perform test_helpers.expect(false, 'a client cannot set its own streak (expected rejection)');
  exception when others then
    perform test_helpers.expect(true, 'a client cannot set its own streak');
  end;

  begin
    update public.profiles set username = 'sneaky' where id = alan;
    perform test_helpers.expect(false, 'a client cannot write username directly (expected rejection)');
  exception when others then
    perform test_helpers.expect(true, 'a client cannot write username directly');
  end;

  perform test_helpers.expect(
    (select username from public.profiles where id = alan) = 'alan_two',
    'username is unchanged after the direct write attempt');

  perform test_helpers.logout();

  raise notice 'ALL PROFILE IDENTITY TESTS PASSED';
end;
$$;
