-- Reject late joins to ringing group calls after the invitation window expires.
-- The room row lock serializes this check with concurrent joins and room updates.
BEGIN;

CREATE OR REPLACE FUNCTION public.join_group_call_room(p_room_id uuid, p_user_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_room public.group_call_rooms%rowtype;
  v_joined integer;
  v_role text;
  v_existing_status text;
BEGIN
  SELECT * INTO v_room
    FROM public.group_call_rooms
   WHERE id = p_room_id
   FOR UPDATE;
  IF NOT FOUND
     OR v_room.status NOT IN ('ringing','active')
     OR (v_room.status = 'ringing' AND v_room.expires_at <= now()) THEN
    RAISE EXCEPTION 'group call is no longer active' USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.conversations c
    JOIN public.conversation_participants cp ON cp.conversation_id = c.id
    WHERE c.id = v_room.conversation_id AND c.is_group = true AND cp.user_id = p_user_id
  ) THEN
    RAISE EXCEPTION 'user is not a member of this group' USING ERRCODE = '42501';
  END IF;

  SELECT status INTO v_existing_status
    FROM public.group_call_participants
   WHERE room_id = p_room_id AND user_id = p_user_id;
  IF NOT FOUND OR v_existing_status = 'declined' THEN
    RAISE EXCEPTION 'user was not invited to this group call' USING ERRCODE = '42501';
  END IF;
  IF v_existing_status <> 'joined' THEN
    SELECT count(*) INTO v_joined
      FROM public.group_call_participants
     WHERE room_id = p_room_id AND status = 'joined';
    IF v_joined >= v_room.max_participants THEN
      RAISE EXCEPTION 'group call is full' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  v_role := CASE WHEN p_user_id = v_room.host_user_id THEN 'host' ELSE 'member' END;
  INSERT INTO public.group_call_participants(room_id, user_id, role, status, joined_at, left_at)
  VALUES (p_room_id, p_user_id, v_role, 'joined', now(), NULL)
  ON CONFLICT (room_id, user_id) DO UPDATE
    SET role = EXCLUDED.role, status = 'joined', joined_at = now(), left_at = NULL;

  UPDATE public.group_call_rooms
     SET status = 'active', started_at = COALESCE(started_at, now())
   WHERE id = p_room_id AND status = 'ringing';
  RETURN v_role;
END;
$$;

REVOKE ALL ON FUNCTION public.join_group_call_room(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.join_group_call_room(uuid, uuid) TO service_role;

COMMIT;
