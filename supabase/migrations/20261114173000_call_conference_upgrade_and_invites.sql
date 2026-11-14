-- Promote an accepted one-to-one call into an SFU conference without
-- exposing room credentials or weakening direct-call participant RLS.
BEGIN;

ALTER TABLE public.group_call_rooms
  ADD COLUMN IF NOT EXISTS source_call_id uuid
    REFERENCES public.call_sessions(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS group_call_rooms_source_call_unique
  ON public.group_call_rooms(source_call_id)
  WHERE source_call_id IS NOT NULL;

ALTER TABLE public.call_sessions
  ADD COLUMN IF NOT EXISTS group_room_id uuid
    REFERENCES public.group_call_rooms(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS call_sessions_group_room_id_idx
  ON public.call_sessions(group_room_id)
  WHERE group_room_id IS NOT NULL;

-- A client may update call status, but only the backend service role may link
-- a direct call to a conference room. The link must match the room's source.
CREATE OR REPLACE FUNCTION public.guard_call_session_group_room_link()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.group_room_id IS DISTINCT FROM OLD.group_room_id THEN
    IF COALESCE(auth.role() = 'service_role', false) IS NOT TRUE THEN
      RAISE EXCEPTION 'only the call service may attach a conference room'
        USING ERRCODE = '42501';
    END IF;
    IF OLD.status <> 'accepted' OR NEW.status <> 'ended' OR NEW.group_room_id IS NULL THEN
      RAISE EXCEPTION 'a conference room can only be attached while promoting an accepted call'
        USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.group_call_rooms r
       WHERE r.id = NEW.group_room_id
         AND r.source_call_id = OLD.id
         AND r.conversation_id = OLD.conversation_id
    ) THEN
      RAISE EXCEPTION 'conference room does not belong to this call'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_call_session_group_room_link ON public.call_sessions;
CREATE TRIGGER guard_call_session_group_room_link
  BEFORE UPDATE OF group_room_id ON public.call_sessions
  FOR EACH ROW EXECUTE FUNCTION public.guard_call_session_group_room_link();

CREATE OR REPLACE FUNCTION public.promote_direct_call_to_group_room(
  p_call_id uuid,
  p_actor_user_id uuid,
  p_room_id uuid,
  p_room_name text,
  p_invited_user_ids uuid[]
)
RETURNS public.group_call_rooms
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_call public.call_sessions%rowtype;
  v_room public.group_call_rooms%rowtype;
  v_other_user_id uuid;
  v_invitee uuid;
  v_invited_count integer := COALESCE(cardinality(p_invited_user_ids), 0);
  v_distinct_count integer;
  v_member_count integer;
  v_is_group boolean;
  v_now timestamptz := now();
BEGIN
  IF p_call_id IS NULL OR p_actor_user_id IS NULL OR p_room_id IS NULL
     OR p_room_name !~ '^zgc_[0-9a-f]{32}$'
     OR v_invited_count NOT BETWEEN 1 AND 14 THEN
    RAISE EXCEPTION 'invalid conference promotion request' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_call
    FROM public.call_sessions
   WHERE id = p_call_id
   FOR UPDATE;

  IF NOT FOUND OR v_call.status <> 'accepted'
     OR v_call.last_activity_at <= v_now - interval '3 minutes'
     OR v_call.group_room_id IS NOT NULL THEN
    RAISE EXCEPTION 'call is no longer available for conference promotion' USING ERRCODE = 'P0001';
  END IF;
  IF p_actor_user_id NOT IN (v_call.caller_id, v_call.callee_id) THEN
    RAISE EXCEPTION 'only a current call participant can add people' USING ERRCODE = '42501';
  END IF;

  SELECT c.is_group INTO v_is_group
    FROM public.conversations c
   WHERE c.id = v_call.conversation_id
   FOR SHARE;
  SELECT count(*) INTO v_member_count
    FROM public.conversation_participants cp
   WHERE cp.conversation_id = v_call.conversation_id;
  IF NOT FOUND OR COALESCE(v_is_group, true) OR v_member_count <> 2 THEN
    RAISE EXCEPTION 'conference promotion requires a direct conversation' USING ERRCODE = '42501';
  END IF;

  SELECT count(DISTINCT invitee.user_id) INTO v_distinct_count
    FROM unnest(COALESCE(p_invited_user_ids, ARRAY[]::uuid[])) AS invitee(user_id);
  IF v_distinct_count <> v_invited_count
     OR EXISTS (
       SELECT 1 FROM unnest(p_invited_user_ids) AS invitee(user_id)
       WHERE invitee.user_id IS NULL
          OR invitee.user_id IN (v_call.caller_id, v_call.callee_id)
     ) THEN
    RAISE EXCEPTION 'conference invitees must be unique additional users' USING ERRCODE = '22023';
  END IF;

  v_other_user_id := CASE WHEN p_actor_user_id = v_call.caller_id
    THEN v_call.callee_id ELSE v_call.caller_id END;

  FOR v_invitee IN
    SELECT invitee.user_id
      FROM unnest(p_invited_user_ids) AS invitee(user_id)
     ORDER BY invitee.user_id
  LOOP
    IF NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = v_invitee) THEN
      RAISE EXCEPTION 'conference invitee not found' USING ERRCODE = '22023';
    END IF;

    IF EXISTS (
      SELECT 1 FROM public.blocked_users b
       WHERE (b.blocker_id = v_invitee AND b.blocked_id IN (v_call.caller_id, v_call.callee_id))
          OR (b.blocked_id = v_invitee AND b.blocker_id IN (v_call.caller_id, v_call.callee_id))
    ) THEN
      RAISE EXCEPTION 'a blocked user cannot be added to this call' USING ERRCODE = '42501';
    END IF;

    IF EXISTS (
      SELECT 1
        FROM public.profile_details d
       WHERE d.user_id = v_invitee
         AND (
           COALESCE(d.profile_visibility, 'everyone') = 'nobody'
           OR (
             COALESCE(d.profile_visibility, 'everyone') = 'contacts'
             AND NOT EXISTS (
               SELECT 1
                 FROM public.conversation_participants mine
                 JOIN public.conversation_participants theirs
                   ON theirs.conversation_id = mine.conversation_id
                WHERE mine.user_id = p_actor_user_id
                  AND theirs.user_id = v_invitee
             )
           )
         )
    ) THEN
      RAISE EXCEPTION 'conference invitee is not discoverable by this caller' USING ERRCODE = '42501';
    END IF;

    IF EXISTS (
      SELECT 1 FROM public.call_sessions c
       WHERE c.id <> p_call_id
         AND (
           (c.status = 'accepted' AND c.last_activity_at > v_now - interval '3 minutes')
           OR (c.status = 'ringing' AND c.expires_at > v_now)
         )
         AND v_invitee IN (c.caller_id, c.callee_id)
    ) OR EXISTS (
      SELECT 1
        FROM public.group_call_participants p
        JOIN public.group_call_rooms r ON r.id = p.room_id
       WHERE p.user_id = v_invitee
         AND p.status = 'joined'
         AND r.status IN ('ringing','active')
    ) THEN
      RAISE EXCEPTION 'conference invitee is already in another call' USING ERRCODE = '23505';
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1
      FROM unnest(p_invited_user_ids) AS a(user_id)
      JOIN unnest(p_invited_user_ids) AS b(user_id) ON a.user_id < b.user_id
      JOIN public.blocked_users blocked
        ON (blocked.blocker_id = a.user_id AND blocked.blocked_id = b.user_id)
        OR (blocked.blocker_id = b.user_id AND blocked.blocked_id = a.user_id)
  ) THEN
    RAISE EXCEPTION 'blocked users cannot share a conference call' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.group_call_rooms(
    id, conversation_id, host_user_id, room_name, call_type,
    status, max_participants, started_at, source_call_id
  ) VALUES (
    p_room_id, v_call.conversation_id, p_actor_user_id, p_room_name,
    v_call.call_type, 'active', 16, v_now, v_call.id
  ) RETURNING * INTO v_room;

  INSERT INTO public.group_call_participants(room_id, user_id, role, status, invited_at, joined_at)
  VALUES
    (p_room_id, p_actor_user_id, 'host', 'joined', v_now, v_now),
    (p_room_id, v_other_user_id, 'member', 'joined', v_now, v_now);

  INSERT INTO public.group_call_participants(room_id, user_id, role, status, invited_at)
  SELECT p_room_id, invitee.user_id, 'member', 'invited', v_now
    FROM unnest(p_invited_user_ids) AS invitee(user_id);

  UPDATE public.call_sessions
     SET status = 'ended',
         group_room_id = p_room_id,
         last_activity_at = v_now
   WHERE id = p_call_id AND status = 'accepted';

  RETURN v_room;
END;
$$;

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
    SET role = EXCLUDED.role, status = 'joined', joined_at = now(), left_at = NULL;

  UPDATE public.group_call_rooms
     SET status = 'active', started_at = COALESCE(started_at, now())
   WHERE id = p_room_id AND status = 'ringing';
  RETURN v_role;
END;
$$;

CREATE OR REPLACE FUNCTION public.invite_group_call_participants(
  p_room_id uuid,
  p_actor_user_id uuid,
  p_user_ids uuid[]
)
RETURNS uuid[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_room public.group_call_rooms%rowtype;
  v_is_admin boolean := false;
  v_user_id uuid;
  v_existing_status text;
  v_invited_at timestamptz;
  v_joined integer;
  v_pending integer;
  v_additional integer := 0;
  v_role text;
BEGIN
  IF p_room_id IS NULL OR p_actor_user_id IS NULL
     OR COALESCE(cardinality(p_user_ids), 0) NOT BETWEEN 1 AND 14
     OR cardinality(p_user_ids) <> (
       SELECT count(DISTINCT requested.user_id)
         FROM unnest(COALESCE(p_user_ids, ARRAY[]::uuid[])) AS requested(user_id)
     ) THEN
    RAISE EXCEPTION 'invalid conference invitation request' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_room
    FROM public.group_call_rooms
   WHERE id = p_room_id
   FOR UPDATE;
  IF NOT FOUND OR v_room.status NOT IN ('ringing','active') THEN
    RAISE EXCEPTION 'group call is no longer active' USING ERRCODE = 'P0001';
  END IF;

  IF v_room.source_call_id IS NULL THEN
    SELECT cp.is_admin INTO v_is_admin
      FROM public.conversation_participants cp
     WHERE cp.conversation_id = v_room.conversation_id
       AND cp.user_id = p_actor_user_id
     FOR SHARE;
    IF NOT FOUND OR (p_actor_user_id <> v_room.host_user_id AND NOT COALESCE(v_is_admin, false)) THEN
      RAISE EXCEPTION 'only the call host or a group admin can invite members' USING ERRCODE = '42501';
    END IF;
  ELSE
    IF p_actor_user_id <> v_room.host_user_id THEN
      RAISE EXCEPTION 'only the call host can invite conference participants' USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.call_sessions c
       WHERE c.id = v_room.source_call_id
         AND c.group_room_id = v_room.id
         AND c.status = 'ended'
    ) THEN
      RAISE EXCEPTION 'conference call is not linked to an active call session' USING ERRCODE = '42501';
    END IF;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.group_call_participants p
     WHERE p.room_id = p_room_id AND p.user_id = p_actor_user_id AND p.status = 'joined'
  ) THEN
    RAISE EXCEPTION 'only a joined call participant can invite people' USING ERRCODE = '42501';
  END IF;

  SELECT count(*) INTO v_joined
    FROM public.group_call_participants
   WHERE room_id = p_room_id AND status = 'joined';
  SELECT count(*) INTO v_pending
    FROM public.group_call_participants
   WHERE room_id = p_room_id AND status = 'invited'
     AND invited_at > now() - interval '2 minutes';

  FOR v_user_id IN
    SELECT requested.user_id
      FROM unnest(p_user_ids) AS requested(user_id)
     ORDER BY requested.user_id
  LOOP
    IF v_user_id IS NULL OR v_user_id = p_actor_user_id
       OR NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = v_user_id) THEN
      RAISE EXCEPTION 'invalid group-call invitee' USING ERRCODE = '22023';
    END IF;

    IF v_room.source_call_id IS NULL AND NOT EXISTS (
      SELECT 1 FROM public.conversation_participants cp
       WHERE cp.conversation_id = v_room.conversation_id AND cp.user_id = v_user_id
    ) THEN
      RAISE EXCEPTION 'only group members can be invited to this call' USING ERRCODE = '42501';
    END IF;

    IF v_room.source_call_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.profile_details d
       WHERE d.user_id = v_user_id
         AND (
           COALESCE(d.profile_visibility, 'everyone') = 'nobody'
           OR (
             COALESCE(d.profile_visibility, 'everyone') = 'contacts'
             AND NOT EXISTS (
               SELECT 1
                 FROM public.conversation_participants mine
                 JOIN public.conversation_participants theirs
                   ON theirs.conversation_id = mine.conversation_id
                WHERE mine.user_id = p_actor_user_id
                  AND theirs.user_id = v_user_id
             )
           )
         )
    ) THEN
      RAISE EXCEPTION 'invitee is not discoverable by this caller' USING ERRCODE = '42501';
    END IF;

    IF EXISTS (
      SELECT 1
        FROM public.group_call_participants current_participant
        JOIN public.blocked_users b
          ON (b.blocker_id = v_user_id AND b.blocked_id = current_participant.user_id)
          OR (b.blocker_id = current_participant.user_id AND b.blocked_id = v_user_id)
       WHERE current_participant.room_id = p_room_id
         AND current_participant.status IN ('joined','invited')
    ) THEN
      RAISE EXCEPTION 'blocked users cannot share a call' USING ERRCODE = '42501';
    END IF;

    IF EXISTS (
      SELECT 1 FROM public.call_sessions c
       WHERE (
         (c.status = 'accepted' AND c.last_activity_at > now() - interval '3 minutes')
         OR (c.status = 'ringing' AND c.expires_at > now())
       )
         AND v_user_id IN (c.caller_id, c.callee_id)
    ) OR EXISTS (
      SELECT 1
        FROM public.group_call_participants p
        JOIN public.group_call_rooms r ON r.id = p.room_id
       WHERE p.user_id = v_user_id
         AND p.status = 'joined'
         AND r.status IN ('ringing','active')
         AND r.id <> p_room_id
    ) THEN
      RAISE EXCEPTION 'invitee is already in another call' USING ERRCODE = '23505';
    END IF;

    SELECT status, invited_at INTO v_existing_status, v_invited_at
      FROM public.group_call_participants
     WHERE room_id = p_room_id AND user_id = v_user_id;

    IF FOUND AND v_existing_status = 'joined' THEN
      RAISE EXCEPTION 'invitee is already in this call' USING ERRCODE = '23505';
    ELSIF FOUND AND v_existing_status = 'declined' THEN
      RAISE EXCEPTION 'invitee already declined this call' USING ERRCODE = '42501';
    ELSIF NOT FOUND OR v_existing_status = 'left'
       OR (v_existing_status = 'invited' AND v_invited_at <= now() - interval '2 minutes') THEN
      v_additional := v_additional + 1;
    END IF;
  END LOOP;

  IF v_joined + v_pending + v_additional > 16 THEN
    RAISE EXCEPTION 'group call participant limit reached' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.group_call_rooms
     SET max_participants = GREATEST(max_participants, v_joined + v_pending + v_additional)
   WHERE id = p_room_id;

  FOREACH v_user_id IN ARRAY p_user_ids LOOP
    INSERT INTO public.group_call_participants(room_id, user_id, role, status, invited_at, joined_at, left_at)
    VALUES (p_room_id, v_user_id, 'member', 'invited', now(), NULL, NULL)
    ON CONFLICT (room_id, user_id) DO UPDATE
      SET status = 'invited', invited_at = now(), joined_at = NULL, left_at = NULL
      WHERE public.group_call_participants.status <> 'joined'
        AND public.group_call_participants.status <> 'declined';
  END LOOP;

  RETURN p_user_ids;
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
  IF p_user_id <> v_room.host_user_id THEN
    RAISE EXCEPTION 'only the conference host can end this call' USING ERRCODE = '42501';
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

REVOKE ALL ON FUNCTION public.promote_direct_call_to_group_room(uuid, uuid, uuid, text, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.promote_direct_call_to_group_room(uuid, uuid, uuid, text, uuid[]) TO service_role;
REVOKE ALL ON FUNCTION public.join_direct_call_room(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.join_direct_call_room(uuid, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.invite_group_call_participants(uuid, uuid, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.invite_group_call_participants(uuid, uuid, uuid[]) TO service_role;
REVOKE ALL ON FUNCTION public.end_direct_call_room(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.end_direct_call_room(uuid, uuid) TO service_role;

COMMENT ON COLUMN public.group_call_rooms.source_call_id IS
  'When non-null, this SFU room is a conference upgrade from an accepted one-to-one call.';
COMMENT ON COLUMN public.call_sessions.group_room_id IS
  'Backend-only link to the SFU room used when a direct call is upgraded to a conference.';

NOTIFY pgrst, 'reload schema';
COMMIT;
