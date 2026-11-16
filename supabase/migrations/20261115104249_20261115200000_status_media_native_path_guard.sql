-- Keep status-media object-key authorization aligned with the native picker
-- formats supported by the app. The owner, row, expiry, and media-kind checks
-- remain unchanged; only the permitted extensions are expanded.
BEGIN;

CREATE OR REPLACE FUNCTION private.can_upload_status_media(p_object_name text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $function$
  select auth.uid() is not null
    and (storage.foldername(p_object_name))[1] = auth.uid()::text
    and exists (
      select 1 from public.status_updates s
      where s.id::text = (storage.foldername(p_object_name))[2]
        and s.user_id = auth.uid() and s.media_path = p_object_name and s.expires_at > now()
        and (
          (s.media_kind = 'image'
            and p_object_name = s.user_id::text || '/' || s.id::text || '/photo.' || storage.extension(p_object_name)
            and storage.extension(p_object_name) in ('jpg','png','webp','gif','heic','heif'))
          or
          (s.media_kind = 'video'
            and p_object_name = s.user_id::text || '/' || s.id::text || '/video.' || storage.extension(p_object_name)
            and storage.extension(p_object_name) in ('mp4','mov'))
        )
    );
$function$;

COMMIT;
