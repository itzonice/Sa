-- Add share_task_titles to profiles table
alter table public.profiles
  add column if not exists share_task_titles boolean not null default false;

-- Update RLS policy to allow owners to update their share_task_titles setting
create policy "profiles_update_own_share_settings" on public.profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());
