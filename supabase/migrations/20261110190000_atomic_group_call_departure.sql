-- Make participant departure and last-member room shutdown atomic.
BEGIN;

CREATE OR REPLACE FUNCTION public.leave_group_call_room(p_room_id uuid, p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_room public.group_call_rooms%rowtype;
  v_joined integer;
  v_updated integer;
BEGIN
  SELECT * INTO v_room
    FROM public.group_call_rooms
   WHERE id = p_room_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  UPDATE public.group_call_participants
     SET status = 'left', left_at = COALESCE(left_at, now())
   WHERE room_id = p_room_id
     AND user_id = p_user_id
     AND status = 'joined';
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated = 0 THEN
    RETURN false;
  END IF;

  SELECT count(*) INTO v_joined
    FROM public.group_call_participants
   WHERE room_id = p_room_id AND status = 'joined';

  IF v_joined = 0 AND v_room.status IN ('ringing','active') THEN
    UPDATE public.group_call_rooms
       SET status = 'ended', ended_at = COALESCE(ended_at, now())
     WHERE id = p_room_id AND status IN ('ringing','active');

    UPDATE public.group_call_participants
       SET status = 'left', left_at = COALESCE(left_at, now())
     WHERE room_id = p_room_id AND status = 'invited';

    RETURN true;
  END IF;

  RETURN false;
END;
$$;

REVOKE ALL ON FUNCTION public.leave_group_call_room(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.leave_group_call_room(uuid, uuid) TO service_role;

COMMIT;
