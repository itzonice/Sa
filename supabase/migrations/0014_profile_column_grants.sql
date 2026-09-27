-- Column grants follow-up to 0012.
--
-- 0012 replaced the blanket UPDATE grant on profiles with an explicit column
-- list, and that list omitted share_task_titles -- added in
-- 0011_add_share_task_titles_to_profiles.sql together with the
-- profiles_update_own_share_settings policy so the settings form could flip it.
-- Without the grant below, the browser's `update profiles set
-- share_task_titles = ...` fails with a permission error even though the RLS
-- policy allows the row.

grant update (share_task_titles)
  on public.profiles
  to authenticated;
