-- Prevent a creator-removed LIVE participant from racing the API guard and rejoining.
-- Preserve follower/private invitation rules and the five-guest capacity check.
BEGIN;

CREATE OR REPLACE FUNCTION public.join_live_stream(p_stream_id uuid, p_user_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_stream public.live_streams%rowtype;
  v_joined integer;
  v_stage_joined integer;
  v_role text;
  v_existing_status text;
  v_invite public.live_stream_invites%rowtype;
  v_has_invite boolean := false;
  v_is_follower boolean := false;
BEGIN
  SELECT * INTO v_stream
    FROM public.live_streams
   WHERE id = p_stream_id
   FOR UPDATE;
  IF NOT FOUND OR v_stream.status <> 'live' THEN
    RAISE EXCEPTION 'LIVE stream has ended' USING ERRCODE = 'P0001';
  END IF;

  IF p_user_id <> v_stream.creator_id AND EXISTS (
    SELECT 1 FROM public.blocked_users b
     WHERE (b.blocker_id = v_stream.creator_id AND b.blocked_id = p_user_id)
        OR (b.blocker_id = p_user_id AND b.blocked_id = v_stream.creator_id)
  ) THEN
    RAISE EXCEPTION 'LIVE stream is unavailable' USING ERRCODE = '42501';
  END IF;

  IF p_user_id <> v_stream.creator_id THEN
    SELECT * INTO v_invite
      FROM public.live_stream_invites
     WHERE stream_id = p_stream_id AND user_id = p_user_id
       AND status IN ('pending','accepted')
     ORDER BY CASE WHEN invitation_type = 'guest' AND status = 'accepted' THEN 0 ELSE 1 END,
              created_at DESC
     LIMIT 1
     FOR UPDATE;
    v_has_invite := FOUND;

    SELECT EXISTS (
      SELECT 1 FROM public.live_creator_follows
       WHERE follower_id = p_user_id AND creator_id = v_stream.creator_id
    ) INTO v_is_follower;

    IF v_stream.visibility = 'followers' AND NOT v_is_follower
       AND NOT (v_has_invite AND v_invite.invitation_type IN ('viewer','guest')) THEN
      RAISE EXCEPTION 'LIVE stream is for followers only' USING ERRCODE = '42501';
    END IF;

    IF v_stream.visibility = 'private'
       AND NOT (v_has_invite AND v_invite.invitation_type IN ('viewer','guest')) THEN
      RAISE EXCEPTION 'LIVE stream invitation required' USING ERRCODE = '42501';
    END IF;
  END IF;

  v_role := CASE
    WHEN p_user_id = v_stream.creator_id THEN 'creator'
    WHEN v_stream.allow_guests AND v_has_invite
      AND v_invite.invitation_type = 'guest' AND v_invite.status = 'accepted' THEN 'guest'
    ELSE 'viewer'
  END;

  IF v_role = 'guest' THEN
    SELECT count(*) INTO v_stage_joined
      FROM public.live_stream_participants
     WHERE stream_id = p_stream_id
       AND role = 'guest'
       AND status = 'joined'
       AND user_id <> p_user_id;
    IF v_stage_joined >= 5 THEN
      RAISE EXCEPTION 'LIVE stage is full' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  SELECT status INTO v_existing_status
    FROM public.live_stream_participants
   WHERE stream_id = p_stream_id AND user_id = p_user_id;
  IF v_existing_status = 'blocked' THEN
    RAISE EXCEPTION 'Creator removed this participant from the LIVE stream'
      USING ERRCODE = '42501';
  END IF;

  IF NOT FOUND OR v_existing_status <> 'joined' THEN
    SELECT count(*) INTO v_joined
      FROM public.live_stream_participants
     WHERE stream_id = p_stream_id AND status = 'joined';
    IF v_joined >= v_stream.viewer_limit THEN
      RAISE EXCEPTION 'LIVE audience is full' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  INSERT INTO public.live_stream_participants(stream_id, user_id, role, status, joined_at, left_at)
  VALUES (p_stream_id, p_user_id, v_role, 'joined', now(), NULL)
  ON CONFLICT (stream_id, user_id) DO UPDATE
    SET role = EXCLUDED.role, status = 'joined', joined_at = now(), left_at = NULL;

  IF v_has_invite AND v_invite.invitation_type = 'viewer' AND v_invite.status = 'pending' THEN
    UPDATE public.live_stream_invites
       SET status = 'accepted', updated_at = now()
     WHERE stream_id = p_stream_id AND user_id = p_user_id;
  END IF;
  RETURN v_role;
END;
$function$;


REVOKE ALL ON FUNCTION public.join_live_stream(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.join_live_stream(uuid, uuid) TO service_role;

COMMIT;
