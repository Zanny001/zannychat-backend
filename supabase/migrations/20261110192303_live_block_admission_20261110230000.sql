-- Recheck creator/viewer block relationships inside the serialized LIVE admission transaction.
BEGIN;

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

  IF p_user_id <> v_stream.creator_id AND EXISTS (
    SELECT 1 FROM public.blocked_users b
     WHERE (b.blocker_id = v_stream.creator_id AND b.blocked_id = p_user_id)
        OR (b.blocker_id = p_user_id AND b.blocked_id = v_stream.creator_id)
  ) THEN
    RAISE EXCEPTION 'LIVE stream is unavailable' USING ERRCODE = '42501';
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

REVOKE ALL ON FUNCTION public.join_live_stream(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.join_live_stream(uuid, uuid) TO service_role;

COMMIT;
