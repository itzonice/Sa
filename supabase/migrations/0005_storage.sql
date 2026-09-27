-- Item 13 (second half): private storage bucket scoped per user.

insert into storage.buckets (id, name, public)
values ('syllabi', 'syllabi', false)
on conflict (id) do nothing;

-- Owner-only access: the first path segment must equal the user's uid
-- (uploads are stored at `${uid}/${uploadId}.pdf`).
create policy "syllabi_owner_read" on storage.objects
  for select to authenticated
  using (bucket_id = 'syllabi' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "syllabi_owner_insert" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'syllabi' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "syllabi_owner_delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'syllabi' and (storage.foldername(name))[1] = auth.uid()::text);
