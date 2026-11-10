-- Message deletion modes: per-viewer hiding and sender-authorized global retraction.
-- Idempotent against the later production reconciliation migration.
BEGIN;

CREATE TABLE IF NOT EXISTS public.message_hidden_for (
  message_id uuid NOT NULL REFERENCES public.messages(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  hidden_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id)
);

ALTER TABLE public.message_hidden_for ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.message_hidden_for FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.message_hidden_for TO authenticated;

DROP POLICY IF EXISTS "Users can read their own message hides" ON public.message_hidden_for;
CREATE POLICY "Users can read their own message hides"
  ON public.message_hidden_for FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "Members can read messages in their conversations" ON public.messages;
DROP POLICY IF EXISTS "Members can read visible messages in their conversations" ON public.messages;
CREATE POLICY "Members can read visible messages in their conversations"
  ON public.messages FOR SELECT TO authenticated
  USING (
    private.is_conversation_member(conversation_id)
    AND NOT EXISTS (
      SELECT 1
      FROM public.message_hidden_for AS mh
      WHERE mh.message_id = messages.id
        AND mh.user_id = (SELECT auth.uid())
    )
  );

CREATE OR REPLACE FUNCTION public.delete_message(p_message_id uuid, p_mode text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_user_id uuid := auth.uid();
  v_message public.messages%ROWTYPE;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;
  IF p_mode IS NULL OR p_mode NOT IN ('me', 'everyone') THEN
    RAISE EXCEPTION 'Invalid deletion mode' USING ERRCODE = '22023';
  END IF;

  SELECT m.* INTO v_message
  FROM public.messages AS m
  WHERE m.id = p_message_id
    AND EXISTS (
      SELECT 1 FROM public.conversation_participants AS cp
      WHERE cp.conversation_id = m.conversation_id AND cp.user_id = v_user_id
    )
  FOR UPDATE OF m;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Message not found' USING ERRCODE = 'P0002';
  END IF;
  IF p_mode = 'me' THEN
    INSERT INTO public.message_hidden_for(message_id, user_id)
    VALUES (p_message_id, v_user_id)
    ON CONFLICT (message_id, user_id) DO NOTHING;
    RETURN;
  END IF;
  IF v_message.sender_id IS DISTINCT FROM v_user_id THEN
    RAISE EXCEPTION 'Only the sender can delete a message for everyone' USING ERRCODE = '42501';
  END IF;
  IF v_message.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Message has already been deleted' USING ERRCODE = '22023';
  END IF;

  UPDATE public.messages
  SET deleted_at = pg_catalog.now(),
      text = '',
      media_url = NULL,
      media_type = NULL,
      media_name = NULL,
      media_size = NULL,
      media_duration = NULL,
      shared_user_id = NULL
  WHERE id = p_message_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.delete_message(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_message(uuid, text) TO authenticated;
REVOKE UPDATE (deleted_at) ON public.messages FROM authenticated;

COMMIT;
