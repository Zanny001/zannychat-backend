-- ZannyChat 1.1.7: make chat attachments private and authorize reads by membership.
-- Apply only after compatible frontend 1.1.1+ is ready.

-- Existing rows store public URLs. Convert known chat-media URLs into an
-- internal marker that the client can resolve to a signed URL after RLS checks.
update public.messages
set media_url = 'storage://chat-media/' || substring(
  media_url from '/storage/v1/object/public/chat-media/([^?#]+)$'
)
where media_url ~ '/storage/v1/object/public/chat-media/[0-9a-fA-F-]{36}/[^?#]+$'
  -- Only rewrite URLs whose object path belongs to this message's own
  -- conversation. This avoids converting arbitrary URLs or mismatched paths
  -- into trusted local Storage markers.
  and split_part(
    substring(media_url from '/storage/v1/object/public/chat-media/([^?#]+)$'),
    '/', 1
  ) = conversation_id::text;

update storage.buckets
set public = false
where id = 'chat-media';

-- Storage RLS helper. A direct subquery against conversation_participants from a
-- storage.objects policy can re-enter that table's own participant policy.
-- SECURITY DEFINER avoids recursive RLS evaluation; the helper only answers
-- whether the current authenticated user belongs to the conversation encoded
-- in this object's first path segment. Keep this in a non-PostgREST schema.
create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;

create or replace function private.is_chat_media_conversation_member(p_object_name text)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select auth.uid() is not null
    and exists (
      select 1
      from public.conversation_participants cp
      where cp.conversation_id::text = (storage.foldername(p_object_name))[1]
        and cp.user_id = auth.uid()
    );
$$;

revoke all on function private.is_chat_media_conversation_member(text) from public, anon, authenticated;
grant execute on function private.is_chat_media_conversation_member(text) to authenticated;

drop policy if exists "Chat media is readable by anyone with the link" on storage.objects;
drop policy if exists "Chat media is readable by conversation participants" on storage.objects;

create policy "Chat media is readable by conversation participants"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'chat-media'
    and private.is_chat_media_conversation_member(name)
  );

drop policy if exists "Only conversation participants can upload chat media" on storage.objects;
create policy "Only conversation participants can upload chat media"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'chat-media'
    and private.is_chat_media_conversation_member(name)
  );
