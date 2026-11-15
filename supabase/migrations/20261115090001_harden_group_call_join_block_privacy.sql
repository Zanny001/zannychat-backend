-- Re-check block relationships at admission time, not only when a group call is created.
-- This prevents a block added after invitation from being bypassed by joining an
-- already-active group call. Both directions are checked against joined and
-- still-invited participants so a room never admits a blocked pair.

CREATE OR REPLACE FUNCTION public.join_group_call_room(p_room_id uuid, p_user_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_room public.group_call_rooms%rowtype;
  v_joined integer;
  v_role text;
  v_existing_status text;
  v_invited_at timestamptz;
BEGIN
  IF p_room_id IS NULL OR p_user_id IS NULL THEN
    RAISE EXCEPTION 'group call room and user are required' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_room
    FROM public.group_call_rooms
   WHERE id = p_room_id
   FOR UPDATE;
  IF NOT FOUND OR v_room.status NOT IN ('ringing','active') THEN
    RAISE EXCEPTION 'group call is no longer active' USING ERRCODE = 'P0001';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.conversations c
    JOIN public.conversation_participants cp ON cp.conversation_id = c.id
    WHERE c.id = v_room.conversation_id AND c.is_group = true AND cp.user_id = p_user_id
  ) THEN
    RAISE EXCEPTION 'user is not a member of this group' USING ERRCODE = '42501';
  END IF;

  -- Re-evaluate blocks on every admission. A block may have been created
  -- after the room and its invitations were originally created.
  IF EXISTS (
    SELECT 1
      FROM public.group_call_participants current_participant
      JOIN public.blocked_users b
        ON (b.blocker_id = p_user_id AND b.blocked_id = current_participant.user_id)
        OR (b.blocker_id = current_participant.user_id AND b.blocked_id = p_user_id)
     WHERE current_participant.room_id = p_room_id
       AND current_participant.user_id <> p_user_id
       AND current_participant.status = 'joined'
  ) THEN
    RAISE EXCEPTION 'blocked users cannot share a group call' USING ERRCODE = '42501';
  END IF;

  SELECT status, invited_at INTO v_existing_status, v_invited_at
    FROM public.group_call_participants
   WHERE room_id = p_room_id AND user_id = p_user_id;
  IF NOT FOUND OR v_existing_status = 'declined' OR v_existing_status = 'left' THEN
    RAISE EXCEPTION 'user was not invited to this group call' USING ERRCODE = '42501';
  END IF;

  IF v_existing_status = 'invited'
     AND v_invited_at IS NOT NULL
     AND v_invited_at <= now() - interval '2 minutes' THEN
    RAISE EXCEPTION 'group call invitation has expired' USING ERRCODE = 'P0001';
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
$function$;

REVOKE ALL ON FUNCTION public.join_group_call_room(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.join_group_call_room(uuid, uuid) TO service_role;
