-- Prevent authenticated senders from restoring the content of a retracted message.
-- Only the sender's text and server-stamped edited_at remain client-editable.
BEGIN;

DROP POLICY IF EXISTS "Senders can edit or delete their own messages" ON public.messages;
DROP POLICY IF EXISTS "Senders can edit active messages in their conversations" ON public.messages;

CREATE POLICY "Senders can edit active messages in their conversations"
  ON public.messages
  FOR UPDATE
  TO authenticated
  USING (
    sender_id = (SELECT auth.uid())
    AND deleted_at IS NULL
    AND private.is_conversation_member(conversation_id)
  )
  WITH CHECK (
    sender_id = (SELECT auth.uid())
    AND deleted_at IS NULL
    AND private.is_conversation_member(conversation_id)
  );

CREATE OR REPLACE FUNCTION private.guard_message_edit_integrity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
BEGIN
  IF current_user = 'authenticated' THEN
    IF OLD.deleted_at IS NOT NULL THEN
      RAISE EXCEPTION 'Retracted messages cannot be edited'
        USING ERRCODE = '42501';
    END IF;

    IF NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
      RAISE EXCEPTION 'Message retraction must use the authorized deletion RPC'
        USING ERRCODE = '42501';
    END IF;

    IF NEW.text IS DISTINCT FROM OLD.text THEN
      NEW.edited_at := pg_catalog.clock_timestamp();
    ELSIF NEW.edited_at IS DISTINCT FROM OLD.edited_at THEN
      RAISE EXCEPTION 'Edit timestamps are managed by the database'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION private.guard_message_edit_integrity() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS guard_message_edit_integrity ON public.messages;
CREATE TRIGGER guard_message_edit_integrity
  BEFORE UPDATE ON public.messages
  FOR EACH ROW
  EXECUTE FUNCTION private.guard_message_edit_integrity();

COMMIT;
