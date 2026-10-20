-- Private photo status foundation. Media is stored in a private bucket and
-- access is checked against the same status visibility rules as status rows.
alter table public.status_updates alter column text drop not null;
alter table public.status_updates add column if not exists media_kind text;
alter table public.status_updates add column if not exists media_path text;
alter table public.status_updates drop constraint if exists status_updates_content_check;
alter table public.status_updates add constraint status_updates_content_check check (
  (text is not null and char_length(btrim(text)) between 1 and 700 and media_kind is null and media_path is null)
  or
  (media_kind = 'image' and media_path is not null and char_length(btrim(coalesce(text, ''))) <= 700)
);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('status-media', 'status-media', false, 10485760, array['image/jpeg','image/png','image/webp']::text[])
on conflict (id) do update set public = false, file_size_limit = 10485760,
  allowed_mime_types = array['image/jpeg','image/png','image/webp']::text[];

drop policy if exists "Status media owner uploads" on storage.objects;
create policy "Status media owner uploads" on storage.objects for insert to authenticated
with check (
  bucket_id = 'status-media'
  and (storage.foldername(name))[1] = auth.uid()::text
  and exists (
    select 1 from public.status_updates s
    where s.id::text = (storage.foldername(name))[2]
      and s.user_id = auth.uid() and s.media_kind = 'image'
      and s.media_path = name and s.expires_at > now()
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
      and (s.user_id = auth.uid() or (
        s.audience = 'contacts' and exists (
          select 1 from public.conversation_participants mine
          join public.conversation_participants theirs on theirs.conversation_id = mine.conversation_id
          where mine.user_id = auth.uid() and theirs.user_id = s.user_id
        )
      ))
  )
);

drop policy if exists "Status media owner deletes" on storage.objects;
create policy "Status media owner deletes" on storage.objects for delete to authenticated
using (
  bucket_id = 'status-media' and (storage.foldername(name))[1] = auth.uid()::text
);
revoke all on storage.objects from anon;

-- Extend the existing status insert/update policies to permit image stories while
-- preserving author-only writes and the 24-hour maximum lifetime.
drop policy if exists "Users can publish own statuses" on public.status_updates;
create policy "Users can publish own statuses" on public.status_updates for insert to authenticated
with check (user_id = (select auth.uid()) and expires_at > now()
  and expires_at <= created_at + interval '24 hours'
  and ((media_kind is null and media_path is null and char_length(btrim(text)) between 1 and 700)
    or (media_kind = 'image' and media_path = 'pending' and char_length(btrim(coalesce(text, ''))) <= 700)));

drop policy if exists "Users can update own media status path" on public.status_updates;
create policy "Users can update own media status path" on public.status_updates for update to authenticated
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()) and media_kind = 'image'
  and media_path = user_id::text || '/' || id::text || '/photo.' || split_part(media_path, '.', 2)
  and expires_at > now() and expires_at <= created_at + interval '24 hours');
grant update on public.status_updates to authenticated;
