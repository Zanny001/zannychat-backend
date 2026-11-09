-- Follow-up to 0065/0066: keep the deletion RPC aligned with the hardened
-- production implementation while preserving the 0066 reference-safe cleanup trigger.
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
