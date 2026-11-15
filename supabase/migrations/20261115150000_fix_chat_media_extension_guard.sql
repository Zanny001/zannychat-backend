-- Correct the chat-media extension guard. Keep this as a forward-only
-- correction because the initial allowlist migration is already applied.
BEGIN;

CREATE OR REPLACE FUNCTION private.can_upload_chat_media(p_object_name text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $function$
  SELECT
    auth.uid() IS NOT NULL
    AND p_object_name !~* '\.(html?|svg|js|mjs|cjs|jsx|tsx|exe|dll|msi|bat|cmd|sh|ps1|vbs|scr|com|jar|apk|dex|php|phtml|asp|aspx|jsp|hta|wasm)$'
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
