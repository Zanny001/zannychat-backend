-- Heartbeat leases prevent crashed viewers and call participants from
-- occupying LIVE audience/stage slots or group-call capacity indefinitely.
ALTER TABLE public.live_stream_participants
  ADD COLUMN IF NOT EXISTS last_seen_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE public.group_call_participants
  ADD COLUMN IF NOT EXISTS last_seen_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS live_stream_participants_active_heartbeat_idx
  ON public.live_stream_participants (last_seen_at)
  WHERE status = 'joined';

CREATE INDEX IF NOT EXISTS group_call_participants_active_heartbeat_idx
  ON public.group_call_participants (last_seen_at)
  WHERE status = 'joined';

-- A participant whose row was marked left by the stale-heartbeat cleaner may
-- rejoin an otherwise-active room. An explicit leave writes last_seen_at at
-- least as recently as left_at and remains non-rejoinable.
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
  v_left_at timestamptz;
  v_last_seen_at timestamptz;
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

  SELECT status, invited_at, left_at, last_seen_at
    INTO v_existing_status, v_invited_at, v_left_at, v_last_seen_at
    FROM public.group_call_participants
   WHERE room_id = p_room_id AND user_id = p_user_id;
  IF NOT FOUND OR v_existing_status = 'declined'
     OR (v_existing_status = 'left' AND (
       v_left_at IS NULL OR v_last_seen_at IS NULL
       OR v_last_seen_at >= v_left_at - interval '30 seconds'
     )) THEN
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
  INSERT INTO public.group_call_participants(room_id, user_id, role, status, joined_at, left_at, last_seen_at)
  VALUES (p_room_id, p_user_id, v_role, 'joined', now(), NULL, now())
  ON CONFLICT (room_id, user_id) DO UPDATE
    SET role = EXCLUDED.role, status = 'joined', joined_at = now(), left_at = NULL, last_seen_at = now();

  UPDATE public.group_call_rooms
     SET status = 'active', started_at = COALESCE(started_at, now())
   WHERE id = p_room_id AND status = 'ringing';
  RETURN v_role;
END;
$function$;

REVOKE ALL ON FUNCTION public.join_group_call_room(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.join_group_call_room(uuid, uuid) TO service_role;

-- Direct-call conference rooms use their own admission function. Apply the
-- same block re-check and stale-heartbeat rejoin rule to those rooms too.
CREATE OR REPLACE FUNCTION public.join_direct_call_room(p_room_id uuid, p_user_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_room public.group_call_rooms%rowtype;
  v_call public.call_sessions%rowtype;
  v_status text;
  v_invited_at timestamptz;
  v_left_at timestamptz;
  v_last_seen_at timestamptz;
  v_joined integer;
  v_role text;
BEGIN
  IF p_room_id IS NULL OR p_user_id IS NULL THEN
    RAISE EXCEPTION 'conference room and user are required' USING ERRCODE = '22023';
  END IF;

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

  IF EXISTS (
    SELECT 1
      FROM public.group_call_participants current_participant
      JOIN public.blocked_users b
        ON (b.blocker_id = p_user_id AND b.blocked_id = current_participant.user_id)
        OR (b.blocker_id = current_participant.user_id AND b.blocked_id = p_user_id)
     WHERE current_participant.room_id = p_room_id
       AND current_participant.user_id <> p_user_id
       AND current_participant.status IN ('joined','invited')
  ) THEN
    RAISE EXCEPTION 'blocked users cannot share a conference call' USING ERRCODE = '42501';
  END IF;

  SELECT status, invited_at, left_at, last_seen_at
    INTO v_status, v_invited_at, v_left_at, v_last_seen_at
    FROM public.group_call_participants
   WHERE room_id = p_room_id AND user_id = p_user_id;
  IF NOT FOUND OR v_status = 'declined'
     OR (v_status = 'left' AND (
       v_left_at IS NULL OR v_last_seen_at IS NULL
       OR v_last_seen_at >= v_left_at - interval '30 seconds'
     )) THEN
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
  INSERT INTO public.group_call_participants(room_id, user_id, role, status, joined_at, left_at, last_seen_at)
  VALUES (p_room_id, p_user_id, v_role, 'joined', now(), NULL, now())
  ON CONFLICT (room_id, user_id) DO UPDATE
    SET role = EXCLUDED.role, status = 'joined', joined_at = now(), left_at = NULL, last_seen_at = now();

  UPDATE public.group_call_rooms
     SET status = 'active', started_at = COALESCE(started_at, now())
   WHERE id = p_room_id AND status = 'ringing';
  RETURN v_role;
END;
$function$;

REVOKE ALL ON FUNCTION public.join_direct_call_room(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.join_direct_call_room(uuid, uuid) TO service_role;

-- Run from the backend's small background worker. A creator who stops
-- heartbeating ends their LIVE; stale viewers/guests free audience/stage slots.
-- Group-call participants are marked left, and empty active rooms are ended so
-- the existing SFU teardown worker can remove the LiveKit room.
CREATE OR REPLACE FUNCTION public.cleanup_stale_media_participants(p_stale_before timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_live_streams_ended integer := 0;
  v_live_participants_left integer := 0;
  v_group_participants_left integer := 0;
  v_group_rooms_ended integer := 0;
BEGIN
  IF p_stale_before IS NULL OR p_stale_before > now() THEN
    RAISE EXCEPTION 'invalid stale participant cutoff' USING ERRCODE = '22023';
  END IF;

  UPDATE public.live_streams s
     SET status = 'ended', ended_at = COALESCE(s.ended_at, now())
   WHERE s.status = 'live'
     AND EXISTS (
       SELECT 1
         FROM public.live_stream_participants creator
        WHERE creator.stream_id = s.id
          AND creator.user_id = s.creator_id
          AND creator.role = 'creator'
          AND creator.status = 'joined'
          AND creator.last_seen_at < p_stale_before
     );
  GET DIAGNOSTICS v_live_streams_ended = ROW_COUNT;

  UPDATE public.live_stream_participants p
     SET status = 'left', left_at = COALESCE(p.left_at, now())
   WHERE p.status = 'joined'
     AND (
       p.role IN ('viewer','guest') AND p.last_seen_at < p_stale_before
       OR EXISTS (
         SELECT 1 FROM public.live_streams s
          WHERE s.id = p.stream_id AND s.status = 'ended'
       )
     );
  GET DIAGNOSTICS v_live_participants_left = ROW_COUNT;

  UPDATE public.group_call_participants p
     SET status = 'left', left_at = COALESCE(p.left_at, now())
   WHERE p.status = 'joined'
     AND p.last_seen_at < p_stale_before;
  GET DIAGNOSTICS v_group_participants_left = ROW_COUNT;

  UPDATE public.group_call_rooms r
     SET status = 'ended', ended_at = COALESCE(r.ended_at, now())
   WHERE r.status = 'active'
     AND NOT EXISTS (
       SELECT 1 FROM public.group_call_participants p
        WHERE p.room_id = r.id AND p.status = 'joined'
     );
  GET DIAGNOSTICS v_group_rooms_ended = ROW_COUNT;

  RETURN pg_catalog.jsonb_build_object(
    'liveStreamsEnded', v_live_streams_ended,
    'liveParticipantsLeft', v_live_participants_left,
    'groupParticipantsLeft', v_group_participants_left,
    'groupRoomsEnded', v_group_rooms_ended
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.cleanup_stale_media_participants(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_stale_media_participants(timestamptz) TO service_role;

NOTIFY pgrst, 'reload schema';
