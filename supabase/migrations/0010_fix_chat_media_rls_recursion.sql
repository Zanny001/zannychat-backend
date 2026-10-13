-- Repair the chat-media SELECT policy for databases that already applied 0009.
-- A policy subquery against conversation_participants can re-enter that table's
-- own RLS policy. Keep the membership lookup in a non-PostgREST SECURITY DEFINER
-- helper and expose only a boolean for the current authenticated user.
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
