-- Avatars: a private Storage bucket, read only through short-lived signed URLs.
--
-- `public = false` is the whole point. With a public bucket the object key is a
-- capability -- anyone who learns `<uid>/avatar.png` can fetch it forever, and it
-- is the kind of URL that ends up in a browser history or a shared screenshot.
-- Private means the only way out is a signed URL minted per request, which the
-- server scopes to the owner and gives a five-minute life (see
-- AVATAR_SIGNED_URL_TTL_SECONDS in packages/core/src/identity/avatar.ts).
--
-- The upload itself is a web form, not an edge function, per the spec: the browser
-- posts the file to this bucket directly using the caller's own JWT, and the
-- Storage policies below are what authorise it. No service-role key is involved,
-- so a compromised form cannot write outside the caller's own folder.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'avatars',
  'avatars',
  false,
  2097152,  -- 2 MiB, matching MAX_AVATAR_BYTES
  array['image/png', 'image/jpeg', 'image/webp']::text[]
)
on conflict (id) do nothing;

-- (No `comment on bucket` here: the syntax for commenting one row of
-- storage.buckets is not something I can verify without a database to run it
-- against, and a migration that fails to parse blocks the whole push.)

-- One policy per verb, each scoped by the first path segment being the caller's
-- uid. The app only ever writes `<uid>/avatar.<ext>`, so the object count in the
-- bucket is bounded by the number of users and replacing an avatar overwrites
-- rather than accumulating orphans.
--
-- The read policy is what lets a signed URL be generated at all: creating one
-- goes through the same authoriser as fetching the object. It does not widen
-- anything, because a client with this policy can already fetch its own avatar
-- with its own token -- which is the point of it being their avatar.

create policy "avatars_owner_read" on storage.objects
  for select to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

-- Upsert on replace, so a second upload to the same key is allowed.
create policy "avatars_owner_insert" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "avatars_owner_update" on storage.objects
  for update to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "avatars_owner_delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

-- No policy for the `anon` role anywhere in this bucket: an unauthenticated
-- visitor cannot read or write an avatar, signed URL or not. `createSignedUrl`
-- with the caller's own token therefore fails for an anonymous request, which is
-- the correct answer rather than an edge case to work around.
