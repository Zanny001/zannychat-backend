-- Keep media buckets private while evaluating upload ownership without
-- re-entering caller-facing RLS policies on the referenced application rows.

create or replace function private.can_upload_chat_media(p_object_name text)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $function$
  select auth.uid() is not null
    and exists (
      select 1
      from public.conversation_participants cp
      where cp.conversation_id::text = (storage.foldername(p_object_name))[1]
        and cp.user_id = auth.uid()
    );
$function$;

revoke all on function private.can_upload_chat_media(text) from public, anon;
grant execute on function private.can_upload_chat_media(text) to authenticated;

drop policy if exists "Conversation members can upload chat media" on storage.objects;
drop policy if exists "Only conversation participants can upload chat media" on storage.objects;
create policy "Conversation members can upload chat media"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'chat-media'
    and private.can_upload_chat_media(name)
  );

create or replace function private.can_upload_status_media(p_object_name text)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $function$
  select auth.uid() is not null
    and (storage.foldername(p_object_name))[1] = auth.uid()::text
    and exists (
      select 1
      from public.status_updates s
      where s.id::text = (storage.foldername(p_object_name))[2]
        and s.user_id = auth.uid()
        and s.media_path = p_object_name
        and s.expires_at > now()
        and (
          (
            s.media_kind = 'image'
            and p_object_name = s.user_id::text || '/' || s.id::text || '/photo.' || storage.extension(p_object_name)
            and storage.extension(p_object_name) in ('jpg', 'png', 'webp')
          )
          or (
            s.media_kind = 'video'
            and p_object_name = s.user_id::text || '/' || s.id::text || '/video.mp4'
            and storage.extension(p_object_name) = 'mp4'
          )
        )
    );
$function$;

revoke all on function private.can_upload_status_media(text) from public, anon;
grant execute on function private.can_upload_status_media(text) to authenticated;

drop policy if exists "Status media owner uploads" on storage.objects;
create policy "Status media owner uploads"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'status-media'
    and private.can_upload_status_media(name)
  );

-- Keep updates restricted to the owner and the exact deterministic object key
-- expected by the corresponding media type (image OR video).
drop policy if exists "Users can update own media status path" on public.status_updates;
create policy "Users can update own media status path"
  on public.status_updates for update
  to authenticated
  using (user_id = (select auth.uid()))
  with check (
    user_id = (select auth.uid())
    and expires_at > now()
    and expires_at <= created_at + interval '48 hours'
    and (
      (
        media_kind = 'image'
        and media_path = user_id::text || '/' || id::text || '/photo.' || split_part(media_path, '.', 2)
        and split_part(media_path, '.', 2) in ('jpg', 'png', 'webp')
      )
      or (
        media_kind = 'video'
        and media_path = user_id::text || '/' || id::text || '/video.mp4'
      )
    )
  );
grant update on public.status_updates to authenticated;
