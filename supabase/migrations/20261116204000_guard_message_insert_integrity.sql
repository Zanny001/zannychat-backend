-- Enforce server-owned message metadata and conversation-bound reply/media references.
-- RLS already validates sender identity and conversation membership, but INSERT
-- grants permit callers to supply every column. This trigger closes the gap.
BEGIN;

CREATE OR REPLACE FUNCTION private.guard_message_insert_integrity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_reply_conversation_id uuid;
  v_reply_deleted_at timestamptz;
  v_expected_prefix text;
  v_object_name text;
BEGIN
  IF current_user = 'authenticated' THEN
    IF v_actor IS NULL OR NEW.sender_id IS DISTINCT FROM v_actor THEN
      RAISE EXCEPTION 'Message sender must match the authenticated user'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  -- Creation/edit/retraction metadata is controlled by Postgres, never by an
  -- authenticated INSERT payload. Existing UPDATE/retraction rules stay intact.
  NEW.created_at := pg_catalog.clock_timestamp();
  NEW.edited_at := NULL;
  NEW.deleted_at := NULL;

  IF NEW.reply_to_id IS NOT NULL THEN
    SELECT m.conversation_id, m.deleted_at
      INTO v_reply_conversation_id, v_reply_deleted_at
    FROM public.messages AS m
    WHERE m.id = NEW.reply_to_id
    FOR KEY SHARE;

    IF NOT FOUND
       OR v_reply_conversation_id IS DISTINCT FROM NEW.conversation_id
       OR v_reply_deleted_at IS NOT NULL THEN
      RAISE EXCEPTION 'Reply target must be an active message in the same conversation'
        USING ERRCODE = '23503';
    END IF;
  END IF;

  IF NEW.shared_user_id IS NOT NULL THEN
    IF NEW.media_url IS NOT NULL
       OR NEW.media_type IS DISTINCT FROM 'contact'
       OR NEW.media_name IS NOT NULL
       OR NEW.media_size IS NOT NULL
       OR NEW.media_duration IS NOT NULL THEN
      RAISE EXCEPTION 'Shared contact messages cannot contain attachment metadata'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.media_url IS NULL THEN
    IF NEW.media_type IS NOT NULL
       OR NEW.media_name IS NOT NULL
       OR NEW.media_size IS NOT NULL
       OR NEW.media_duration IS NOT NULL THEN
      RAISE EXCEPTION 'Attachment metadata requires an uploaded media object'
        USING ERRCODE = '23514';
    END IF;
    IF pg_catalog.btrim(NEW.text) = '' THEN
      RAISE EXCEPTION 'A text message cannot be empty'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    IF COALESCE(NEW.media_type, '') NOT IN ('image', 'video', 'file', 'voice') THEN
      RAISE EXCEPTION 'Unsupported chat attachment type'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.shared_user_id IS NOT NULL THEN
      RAISE EXCEPTION 'A message cannot combine a shared contact and a media attachment'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.media_size IS NOT NULL AND NEW.media_size NOT BETWEEN 0 AND 26214400 THEN
      RAISE EXCEPTION 'Chat attachment exceeds the allowed size'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.media_duration IS NOT NULL AND NEW.media_duration NOT BETWEEN 0 AND 86400 THEN
      RAISE EXCEPTION 'Invalid chat attachment duration'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.media_name IS NOT NULL AND pg_catalog.char_length(NEW.media_name) > 512 THEN
      RAISE EXCEPTION 'Chat attachment name is too long'
        USING ERRCODE = '23514';
    END IF;

    v_expected_prefix := 'storage://chat-media/' || NEW.conversation_id::text || '/';
    IF pg_catalog.left(NEW.media_url, pg_catalog.length(v_expected_prefix))
       IS DISTINCT FROM v_expected_prefix THEN
      RAISE EXCEPTION 'Chat attachment must belong to this conversation'
        USING ERRCODE = '42501';
    END IF;

    v_object_name := pg_catalog.substr(
      NEW.media_url,
      pg_catalog.length('storage://chat-media/') + 1
    );
    IF v_object_name !~ ('^' || NEW.conversation_id::text || '/[^/]+$') THEN
      RAISE EXCEPTION 'Invalid chat attachment object path'
        USING ERRCODE = '22023';
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM storage.objects AS o
      WHERE o.bucket_id = 'chat-media'
        AND o.name = v_object_name
        AND o.owner = NEW.sender_id
    ) THEN
      RAISE EXCEPTION 'Chat attachment must be uploaded by the message sender'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  IF NEW.media_type = 'contact' AND NEW.shared_user_id IS NULL THEN
    RAISE EXCEPTION 'Contact messages require a shared profile'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION private.guard_message_insert_integrity()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS guard_message_insert_integrity ON public.messages;
CREATE TRIGGER guard_message_insert_integrity
  BEFORE INSERT ON public.messages
  FOR EACH ROW
  EXECUTE FUNCTION private.guard_message_insert_integrity();

COMMIT;
