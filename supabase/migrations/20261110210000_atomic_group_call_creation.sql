-- Create group-call room and invitations in one transaction.
BEGIN;

CREATE OR REPLACE FUNCTION public.create_group_call_room(
  p_conversation_id uuid,
  p_host_user_id uuid,
  p_room_id uuid,
  p_room_name text,
  p_call_type text,
  p_max_participants integer,
  p_invited_user_ids uuid[]
)
RETURNS public.group_call_rooms
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_room public.group_call_rooms%rowtype;
  v_invited_count integer := COALESCE(cardinality(p_invited_user_ids), 0);
  v_invitee uuid;
  v_stale_room record;
  v_now timestamptz := now();
BEGIN
  IF p_call_type IS NULL OR p_call_type NOT IN ('audio','video')
     OR p_max_participants IS NULL OR p_max_participants NOT BETWEEN 2 AND 16
     OR v_invited_count <> p_max_participants - 1
     OR v_invited_count <> (SELECT count(DISTINCT invitee.user_id) FROM unnest(COALESCE(p_invited_user_ids, ARRAY[]::uuid[])) AS invitee(user_id))
     OR p_host_user_id = ANY(COALESCE(p_invited_user_ids, ARRAY[]::uuid[])) THEN
    RAISE EXCEPTION 'invalid group call participants or settings' USING ERRCODE = '22023';
  END IF;

  PERFORM 1 FROM public.conversations c
   WHERE c.id = p_conversation_id AND c.is_group = true
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'group conversation not found' USING ERRCODE = '42501';
  END IF;

  PERFORM 1 FROM public.conversation_participants cp
   WHERE cp.conversation_id = p_conversation_id AND cp.user_id = p_host_user_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'host is not a member of this group' USING ERRCODE = '42501';
  END IF;

  FOR v_invitee IN
    SELECT invitee.user_id
      FROM unnest(COALESCE(p_invited_user_ids, ARRAY[]::uuid[])) AS invitee(user_id)
     ORDER BY invitee.user_id
  LOOP
    PERFORM 1 FROM public.conversation_participants cp
     WHERE cp.conversation_id = p_conversation_id AND cp.user_id = v_invitee
     FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'an invited user is not a member of this group' USING ERRCODE = '42501';
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1
      FROM unnest(COALESCE(p_invited_user_ids, ARRAY[]::uuid[])) AS invitee(user_id)
      JOIN public.blocked_users b
        ON (b.blocker_id = p_host_user_id AND b.blocked_id = invitee.user_id)
        OR (b.blocker_id = invitee.user_id AND b.blocked_id = p_host_user_id)
  ) THEN
    RAISE EXCEPTION 'blocked group member cannot be invited' USING ERRCODE = '42501';
  END IF;

  FOR v_stale_room IN
    SELECT r.id, r.host_user_id
      FROM public.group_call_rooms r
     WHERE r.conversation_id = p_conversation_id
       AND r.status IN ('ringing','active')
       AND COALESCE(r.started_at, r.created_at) <= v_now - interval '2 minutes'
     FOR UPDATE
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM public.group_call_participants p
       WHERE p.room_id = v_stale_room.id
         AND p.user_id <> v_stale_room.host_user_id
         AND p.status = 'joined'
    ) THEN
      UPDATE public.group_call_rooms
         SET status = 'ended', ended_at = COALESCE(ended_at, v_now)
       WHERE id = v_stale_room.id AND status IN ('ringing','active');

      UPDATE public.group_call_participants
         SET status = 'left', left_at = COALESCE(left_at, v_now)
       WHERE room_id = v_stale_room.id AND status = 'invited';
    END IF;
  END LOOP;

  INSERT INTO public.group_call_rooms(
    id, conversation_id, host_user_id, room_name, call_type,
    status, max_participants, started_at
  ) VALUES (
    p_room_id, p_conversation_id, p_host_user_id, p_room_name, p_call_type,
    'active', p_max_participants, v_now
  ) RETURNING * INTO v_room;

  INSERT INTO public.group_call_participants(room_id, user_id, role, status, invited_at, joined_at)
  VALUES (p_room_id, p_host_user_id, 'host', 'joined', v_now, v_now);

  INSERT INTO public.group_call_participants(room_id, user_id, role, status, invited_at)
  SELECT p_room_id, invitee.user_id, 'member', 'invited', v_now
    FROM unnest(COALESCE(p_invited_user_ids, ARRAY[]::uuid[])) AS invitee(user_id);

  RETURN v_room;
END;
$$;

REVOKE ALL ON FUNCTION public.create_group_call_room(uuid, uuid, uuid, text, text, integer, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_group_call_room(uuid, uuid, uuid, text, text, integer, uuid[]) TO service_role;

COMMIT;
