-- Serialize participant admission so concurrent joins cannot exceed room caps.
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

  SELECT status INTO v_existing_status
    FROM public.group_call_participants
   WHERE room_id = p_room_id AND user_id = p_user_id;
  IF NOT FOUND OR v_existing_status <> 'joined' THEN
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

CREATE OR REPLACE FUNCTION public.join_live_stream(p_stream_id uuid, p_user_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_stream public.live_streams%rowtype;
  v_joined integer;
  v_role text;
  v_existing_status text;
BEGIN
  SELECT * INTO v_stream
    FROM public.live_streams
   WHERE id = p_stream_id
   FOR UPDATE;
  IF NOT FOUND OR v_stream.status <> 'live' THEN
    RAISE EXCEPTION 'LIVE stream has ended' USING ERRCODE = 'P0001';
  END IF;
  IF v_stream.visibility <> 'public' AND v_stream.creator_id <> p_user_id THEN
    RAISE EXCEPTION 'LIVE stream is not public' USING ERRCODE = '42501';
  END IF;

  SELECT status INTO v_existing_status
    FROM public.live_stream_participants
   WHERE stream_id = p_stream_id AND user_id = p_user_id;
  IF NOT FOUND OR v_existing_status <> 'joined' THEN
    SELECT count(*) INTO v_joined
      FROM public.live_stream_participants
     WHERE stream_id = p_stream_id AND status = 'joined';
    IF v_joined >= v_stream.viewer_limit THEN
      RAISE EXCEPTION 'LIVE audience is full' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  v_role := CASE WHEN p_user_id = v_stream.creator_id THEN 'creator' ELSE 'viewer' END;
  INSERT INTO public.live_stream_participants(stream_id, user_id, role, status, joined_at, left_at)
  VALUES (p_stream_id, p_user_id, v_role, 'joined', now(), NULL)
  ON CONFLICT (stream_id, user_id) DO UPDATE
    SET role = EXCLUDED.role, status = 'joined', joined_at = now(), left_at = NULL;
  RETURN v_role;
END;
$$;

REVOKE ALL ON FUNCTION public.join_group_call_room(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.join_live_stream(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.join_group_call_room(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.join_live_stream(uuid, uuid) TO service_role;

COMMIT;