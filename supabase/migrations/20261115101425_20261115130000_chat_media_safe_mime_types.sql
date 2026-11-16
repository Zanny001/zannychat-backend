-- Restrict chat uploads to media and downloadable document types.
-- Keep application/octet-stream for unknown binary documents, but block active
-- web/script/executable extensions even when a client mislabels the MIME type.
BEGIN;

UPDATE storage.buckets
SET allowed_mime_types = ARRAY[
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/heic',
  'image/heif',
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'video/3gpp',
  'audio/m4a',
  'audio/mp4',
  'audio/mpeg',
  'audio/aac',
  'audio/wav',
  'audio/ogg',
  'audio/webm',
  'application/pdf',
  'application/octet-stream',
  'application/zip',
  'application/x-zip-compressed',
  'application/x-7z-compressed',
  'application/x-rar-compressed',
  'application/vnd.rar',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/rtf',
  'application/json',
  'application/epub+zip',
  'application/gzip',
  'application/x-tar',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.presentation',
  'text/plain',
  'text/csv',
  'text/markdown'
]
WHERE id = 'chat-media';

CREATE OR REPLACE FUNCTION private.can_upload_chat_media(p_object_name text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $function$
  SELECT
    auth.uid() IS NOT NULL
    AND p_object_name !~* '\\.(html?|svg|js|mjs|cjs|jsx|tsx|exe|dll|msi|bat|cmd|sh|ps1|vbs|scr|com|jar|apk|dex|php|phtml|asp|aspx|jsp|hta|wasm)$'
    AND EXISTS (
      SELECT 1
      FROM public.conversation_participants AS cp
      WHERE cp.conversation_id::text = (storage.foldername(p_object_name))[1]
        AND cp.user_id = auth.uid()
    );
$function$;

REVOKE ALL ON FUNCTION private.can_upload_chat_media(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.can_upload_chat_media(text) TO authenticated;

COMMENT ON FUNCTION private.can_upload_chat_media(text) IS
  'Allows active conversation members to upload private chat media while rejecting active web/script/executable filename extensions.';

COMMIT;
