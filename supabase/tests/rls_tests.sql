-- Items 10, 11, 12: SQL tests. Run with `pnpm db:tests`.
-- Plain SQL + DO blocks with explicit PASS/FAIL output (no extra extensions).

\set user_a '11111111-1111-1111-1111-111111111111'
\set user_b '22222222-2222-2222-2222-222222222222'

create schema if not exists test_helpers;

-- The suite switches roles mid-run (login() does SET ROLE 'authenticated'), and
-- the helper calls that follow run as the switched role: EXECUTE defaults to
-- PUBLIC for functions, but schema USAGE does not default to anyone, so grant
-- it or every post-login expect() dies with "permission denied for schema".
grant usage on schema test_helpers to public;

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

create or replace function test_helpers.setup()
returns void language plpgsql as $$
begin
  insert into auth.users (instance_id, id, aud, role, email, email_confirmed_at, created_at, updated_at)
  values
    ('00000000-0000-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111'::uuid, 'authenticated', 'authenticated', 'a@t.test', now(), now(), now()),
    ('00000000-0000-0000-0000-000000000000', '22222222-2222-2222-2222-222222222222'::uuid, 'authenticated', 'authenticated', 'b@t.test', now(), now(), now())
  on conflict (id) do nothing;

  insert into public.profiles (id, timezone)
  values ('11111111-1111-1111-1111-111111111111'::uuid, 'UTC'), ('22222222-2222-2222-2222-222222222222'::uuid, 'UTC')
  on conflict (id) do nothing;

  insert into public.courses (id, owner_id, title) values
    ('aaaaaaaa-0000-0000-0000-00000000a001', '11111111-1111-1111-1111-111111111111'::uuid, 'A Course'),
    ('aaaaaaaa-0000-0000-0000-00000000b001', '22222222-2222-2222-2222-222222222222'::uuid, 'B Course')
  on conflict (id) do nothing;
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

do $$
declare
  a uuid := '11111111-1111-1111-1111-111111111111';
  b uuid := '22222222-2222-2222-2222-222222222222';
  course_a uuid := 'aaaaaaaa-0000-0000-0000-00000000a001';
  course_b uuid := 'aaaaaaaa-0000-0000-0000-00000000b001';
  visible int;
begin
  perform test_helpers.setup();

  -- ===== Item 10: user A cannot touch user B's rows =====

  -- A sees only their own courses
  perform test_helpers.login(a);
  select count(*) into visible from public.courses;
  perform test_helpers.expect(visible = 1, 'user A sees exactly 1 course (their own)');

  -- A cannot update B's course
  update public.courses set title = 'hacked' where id = course_b;
  perform test_helpers.expect(not exists (select 1 from public.courses where id = course_b and title = 'hacked'),
    'user A cannot update user B''s course');

  -- A cannot insert an assignment into B's course
  begin
    insert into public.assignments (course_id, title, due_at) values (course_b, 'intrusion', now() + interval '1 day');
    perform test_helpers.expect(false, 'user A cannot insert into user B''s course (expected rejection)');
  exception when insufficient_privilege or check_violation then
    perform test_helpers.expect(true, 'user A cannot insert into user B''s course');
  end;

  -- A cannot delete B's course
  delete from public.courses where id = course_b;
  perform test_helpers.expect(exists (select 1 from public.courses where id = course_b),
    'user A cannot delete user B''s course');

  -- Child table: A cannot attach a grade category to B's course
  begin
    insert into public.grade_categories (course_id, name, weight) values (course_b, 'x', 10);
    perform test_helpers.expect(false, 'user A cannot insert grade_category into user B''s course (expected rejection)');
  exception when insufficient_privilege or check_violation then
    perform test_helpers.expect(true, 'user A cannot insert grade_category into user B''s course');
  end;

  perform test_helpers.logout();

  -- ===== Item 11: check constraints =====

  perform test_helpers.login(a);

  -- Weight out of range
  begin
    insert into public.grade_categories (course_id, name, weight) values (course_a, 'bad', 150);
    perform test_helpers.expect(false, 'weight > 100 is rejected (expected rejection)');
  exception when check_violation then
    perform test_helpers.expect(true, 'weight > 100 is rejected');
  end;

  -- Negative minutes rejected (positive durations)
  begin
    insert into public.study_sessions (owner_id, course_id, started_at, ended_at, minutes)
    values (a, course_a, now(), now() + interval '1 hour', -5);
    perform test_helpers.expect(false, 'negative study session minutes rejected (expected rejection)');
  exception when check_violation then
    perform test_helpers.expect(true, 'negative study session minutes rejected');
  end;

  -- Extra credit: score above max_score is allowed (valid score ranges)
  insert into public.assignments (course_id, title, due_at, score, max_score)
  values (course_a, 'extra credit', now(), 105, 100);
  perform test_helpers.expect(true, 'extra credit (score > max_score) is allowed');

  perform test_helpers.logout();

  -- ===== Item 12: session/assignment course-match trigger =====

  perform test_helpers.login(a);
  insert into public.assignments (id, course_id, title, due_at)
  values ('aaaaaaaa-0000-0000-0000-00000000a002', course_a, 'A assignment', now() + interval '2 days');

  -- Wrong-course session must be rejected by the trigger
  begin
    insert into public.study_sessions (owner_id, course_id, assignment_id, started_at, ended_at, minutes)
    values (a, course_a, 'aaaaaaaa-0000-0000-0000-00000000b002', now(), now() + interval '30 minutes', 30);
    perform test_helpers.expect(false, 'session with mismatched assignment course rejected (expected rejection)');
  exception when others then
    perform test_helpers.expect(true, 'session with mismatched assignment course rejected');
  end;

  -- Matching-course session passes
  insert into public.study_sessions (owner_id, course_id, assignment_id, started_at, ended_at, minutes)
  values (a, course_a, 'aaaaaaaa-0000-0000-0000-00000000a002', now(), now() + interval '30 minutes', 30);
  perform test_helpers.expect(true, 'session with matching assignment course accepted');

  perform test_helpers.logout();

  raise notice 'ALL SQL TESTS PASSED';
end;
$$;
