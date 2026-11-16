-- Keep conference reconnects from resetting participant duration, and allow
-- either active participant in a promoted one-to-one call to end the conference.
BEGIN;

CREATE OR REPLACE FUNCTION public.join_direct_call_room(
  p_room_id uuid,
  p_user_id uuid
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_room public.group_call_rooms%rowtype;
  v_call public.call_sessions%rowtype;
  v_status text;
  v_invited_at timestamptz;
  v_joined integer;
  v_role text;
BEGIN
  SELECT * INTO v_room
    FROM public.group_call_rooms
   WHERE id = p_room_id
   FOR UPDATE;
  IF NOT FOUND OR v_room.source_call_id IS NULL
     OR v_room.status NOT IN ('ringing','active') THEN
    RAISE EXCEPTION 'conference call is no longer active' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_call
    FROM public.call_sessions
   WHERE id = v_room.source_call_id;
  IF NOT FOUND OR v_call.group_room_id <> p_room_id OR v_call.status <> 'ended' THEN
    RAISE EXCEPTION 'conference call is not linked to the original call' USING ERRCODE = '42501';
  END IF;

  SELECT status, invited_at INTO v_status, v_invited_at
    FROM public.group_call_participants
   WHERE room_id = p_room_id AND user_id = p_user_id;
  IF NOT FOUND OR v_status IN ('declined','left') THEN
    RAISE EXCEPTION 'user was not invited to this conference call' USING ERRCODE = '42501';
  END IF;
  IF v_status = 'invited' AND v_invited_at <= now() - interval '2 minutes' THEN
    RAISE EXCEPTION 'conference call invitation has expired' USING ERRCODE = 'P0001';
  END IF;

  IF v_status <> 'joined' THEN
    SELECT count(*) INTO v_joined
      FROM public.group_call_participants
     WHERE room_id = p_room_id AND status = 'joined';
    IF v_joined >= v_room.max_participants THEN
      RAISE EXCEPTION 'conference call is full' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  v_role := CASE WHEN p_user_id = v_room.host_user_id THEN 'host' ELSE 'member' END;
  INSERT INTO public.group_call_participants(room_id, user_id, role, status, joined_at, left_at)
  VALUES (p_room_id, p_user_id, v_role, 'joined', now(), NULL)
  ON CONFLICT (room_id, user_id) DO UPDATE
    SET role = EXCLUDED.role,
        status = 'joined',
        joined_at = COALESCE(public.group_call_participants.joined_at, EXCLUDED.joined_at),
        left_at = NULL;

  UPDATE public.group_call_rooms
     SET status = 'active', started_at = COALESCE(started_at, now())
   WHERE id = p_room_id AND status = 'ringing';
  RETURN v_role;
END;
$$;

CREATE OR REPLACE FUNCTION public.end_direct_call_room(
  p_room_id uuid,
  p_user_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_room public.group_call_rooms%rowtype;
BEGIN
  SELECT * INTO v_room
    FROM public.group_call_rooms
   WHERE id = p_room_id
   FOR UPDATE;
  IF NOT FOUND OR v_room.source_call_id IS NULL
     OR v_room.status NOT IN ('ringing','active') THEN
    RETURN false;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.group_call_participants p
     WHERE p.room_id = p_room_id
       AND p.user_id = p_user_id
       AND p.status = 'joined'
  ) THEN
    RAISE EXCEPTION 'only a connected participant can end this conference' USING ERRCODE = '42501';
  END IF;

  UPDATE public.group_call_rooms
     SET status = 'ended', ended_at = COALESCE(ended_at, now())
   WHERE id = p_room_id AND status IN ('ringing','active');
  UPDATE public.group_call_participants
     SET status = 'left', left_at = COALESCE(left_at, now())
   WHERE room_id = p_room_id AND status IN ('invited','joined');
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.join_direct_call_room(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.join_direct_call_room(uuid, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.end_direct_call_room(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.end_direct_call_room(uuid, uuid) TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
