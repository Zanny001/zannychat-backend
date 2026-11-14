-- Preserve the live media mode when a direct call is promoted to an SFU room.
-- The existing promotion RPC remains the single authority for participant checks,
-- invitee privacy, blocked-user rules, concurrency and atomic room creation.
CREATE OR REPLACE FUNCTION public.promote_direct_call_to_group_room_with_media(
  p_call_id uuid,
  p_actor_user_id uuid,
  p_room_id uuid,
  p_room_name text,
  p_invited_user_ids uuid[],
  p_call_type text
)
RETURNS public.group_call_rooms
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_room public.group_call_rooms%rowtype;
BEGIN
  IF p_call_type NOT IN ('audio', 'video') THEN
    RAISE EXCEPTION 'unsupported conference media type' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_room
    FROM public.promote_direct_call_to_group_room(
      p_call_id,
      p_actor_user_id,
      p_room_id,
      p_room_name,
      p_invited_user_ids
    );

  UPDATE public.group_call_rooms
     SET call_type = p_call_type
   WHERE id = v_room.id
     AND source_call_id = p_call_id
     AND host_user_id = p_actor_user_id
     AND status IN ('ringing', 'active')
  RETURNING * INTO v_room;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'conference room media mode could not be updated' USING ERRCODE = 'P0001';
  END IF;

  RETURN v_room;
END;
$$;

REVOKE ALL ON FUNCTION public.promote_direct_call_to_group_room_with_media(uuid, uuid, uuid, text, uuid[], text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.promote_direct_call_to_group_room_with_media(uuid, uuid, uuid, text, uuid[], text)
  TO service_role;
