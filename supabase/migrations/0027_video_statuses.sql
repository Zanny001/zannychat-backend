-- Video Stories: MP4-only uploads with a 50 MiB ceiling in the existing private bucket.
-- Existing image policy behavior remains private and expiry/contact scoped.

alter table public.status_updates drop constraint if exists status_updates_content_check;
alter table public.status_updates add constraint status_updates_content_check check (
  (text is not null and char_length(btrim(text)) between 1 and 700 and media_kind is null and media_path is null)
  or (media_kind = 'image' and media_path is not null and char_length(btrim(coalesce(text, ''))) <= 700)
  or (media_kind = 'video' and media_path is not null and char_length(btrim(coalesce(text, ''))) <= 700)
);

update storage.buckets set public = false, file_size_limit = 52428800,
  allowed_mime_types = array['image/jpeg','image/png','image/webp','video/mp4']::text[]
where id = 'status-media';

-- Extend the exact-path upload policy to MP4 videos while retaining author ownership.
drop policy if exists "Status media owner uploads" on storage.objects;
create policy "Status media owner uploads" on storage.objects for insert to authenticated
with check (
  bucket_id = 'status-media'
  and (storage.foldername(name))[1] = auth.uid()::text
  and exists (
    select 1 from public.status_updates s
    where s.id::text = (storage.foldername(name))[2]
      and s.user_id = auth.uid() and s.media_kind in ('image','video')
      and s.media_path = name and s.expires_at > now()
      and ((s.media_kind = 'image' and name = s.user_id::text || '/' || s.id::text || '/photo.' || split_part(name, '.', 2) and split_part(name, '.', 2) in ('jpg','png','webp') and coalesce((metadata->>'size')::bigint, 0) between 1 and 10485760)
        or (s.media_kind = 'video' and name = auth.uid()::text || '/' || s.id::text || '/video.mp4' and coalesce((metadata->>'size')::bigint, 0) between 1 and 52428800))
  )
);

drop policy if exists "Status media visible to authorized viewers" on storage.objects;
create policy "Status media visible to authorized viewers" on storage.objects for select to authenticated
using (
  bucket_id = 'status-media'
  and exists (
    select 1 from public.status_updates s
    where s.id::text = (storage.foldername(name))[2]
      and s.user_id::text = (storage.foldername(name))[1]
      and s.media_path = name and s.expires_at > now()
      and s.media_kind in ('image','video')
      and (s.user_id = auth.uid() or (
        s.audience = 'contacts' and exists (
          select 1 from public.conversation_participants mine
          join public.conversation_participants theirs on theirs.conversation_id = mine.conversation_id
          where mine.user_id = auth.uid() and theirs.user_id = s.user_id
        )
      ))
  )
);


drop policy if exists "Users can publish own statuses" on public.status_updates;
create policy "Users can publish own statuses" on public.status_updates for insert to authenticated
with check (user_id = (select auth.uid()) and expires_at > now()
  and expires_at <= created_at + interval '24 hours'
  and ((media_kind is null and media_path is null and text is not null and char_length(btrim(text)) between 1 and 700)
    or (media_kind = 'image' and media_path = 'pending' and char_length(btrim(coalesce(text, ''))) <= 700)
    or (media_kind = 'video' and media_path = 'pending' and char_length(btrim(coalesce(text, ''))) <= 700)));

-- Owner may update only their own placeholder to the matching final object path.
drop policy if exists "Users can update own media status path" on public.status_updates;
create policy "Users can update own media status path" on public.status_updates for update to authenticated
using (user_id = (select auth.uid()))
with check (
  user_id = (select auth.uid()) and expires_at > now()
  and expires_at <= created_at + interval '24 hours'
  and ((media_kind = 'image' and media_path = user_id::text || '/' || id::text || '/photo.' || split_part(media_path, '.', 2)
        and split_part(media_path, '.', 2) in ('jpg','png','webp'))
    or (media_kind = 'video' and media_path = user_id::text || '/' || id::text || '/video.mp4'))
);
