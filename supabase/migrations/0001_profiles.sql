-- Item 7: profiles table with signup trigger.

create type public.plan_tier as enum ('free', 'pro');

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  timezone text not null default 'UTC'
    check (timezone ~ '^[A-Za-z_]+/[A-Za-z_]+$' or timezone = 'UTC'),
  school text,
  plan_tier public.plan_tier not null default 'free',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.profiles is 'One row per auth user; timezone is the source of truth for all local-time conversions.';

-- Create a profile whenever a user signs up (raw_user_meta_data may carry
-- timezone / school from the signup form).
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, timezone, school)
  values (
    new.id,
    coalesce(nullif(new.raw_user_meta_data ->> 'timezone', ''), 'UTC'),
    nullif(new.raw_user_meta_data ->> 'school', '')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
