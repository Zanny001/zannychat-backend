-- Align group-call columns with route payloads and make host/admin termination atomic.
BEGIN;

ALTER TABLE public.group_call_rooms
  ADD COLUMN IF NOT EXISTS call_type text NOT NULL DEFAULT 'audio'
  CHECK (call_type IN ('audio','video'));

CREATE OR REPLACE FUNCTION public.end_group_call_room(p_room_id uuid, p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_room public.group_call_rooms%rowtype;
  v_is_admin boolean;
BEGIN
  SELECT * INTO v_room
    FROM public.group_call_rooms
   WHERE id = p_room_id
   FOR UPDATE;

  IF NOT FOUND OR v_room.status NOT IN ('ringing','active') THEN
    RETURN false;
  END IF;

  SELECT COALESCE(bool_or(cp.is_admin), false) INTO v_is_admin
    FROM public.conversation_participants cp
   WHERE cp.conversation_id = v_room.conversation_id
     AND cp.user_id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'user is not a member of this group' USING ERRCODE = '42501';
  END IF;

  IF p_user_id <> v_room.host_user_id AND NOT v_is_admin THEN
    RAISE EXCEPTION 'only the call host or a group admin can end this call' USING ERRCODE = '42501';
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

REVOKE ALL ON FUNCTION public.end_group_call_room(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.end_group_call_room(uuid, uuid) TO service_role;

COMMIT;
