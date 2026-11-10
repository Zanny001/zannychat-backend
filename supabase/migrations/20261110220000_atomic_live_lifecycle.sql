-- Keep creator LIVE stream lifecycle changes and creator presence atomic.
BEGIN;

CREATE OR REPLACE FUNCTION public.create_live_stream(
  p_stream_id uuid,
  p_creator_id uuid,
  p_title text,
  p_description text,
  p_room_name text
)
RETURNS public.live_streams
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_stream public.live_streams%rowtype;
  v_now timestamptz := now();
BEGIN
  IF p_title IS NULL OR char_length(btrim(p_title)) NOT BETWEEN 1 AND 80
     OR p_description IS NULL OR char_length(p_description) > 500
     OR p_room_name IS NULL OR char_length(p_room_name) NOT BETWEEN 1 AND 128 THEN
    RAISE EXCEPTION 'invalid LIVE stream details' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.live_streams(
    id, creator_id, title, description, visibility, room_name, status, started_at
  ) VALUES (
    p_stream_id, p_creator_id, btrim(p_title), btrim(p_description), 'public',
    p_room_name, 'live', v_now
  ) RETURNING * INTO v_stream;

  INSERT INTO public.live_stream_participants(stream_id, user_id, role, status, joined_at)
  VALUES (p_stream_id, p_creator_id, 'creator', 'joined', v_now);

  RETURN v_stream;
END;
$$;

CREATE OR REPLACE FUNCTION public.end_live_stream(p_stream_id uuid, p_creator_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_stream public.live_streams%rowtype;
  v_updated integer;
  v_now timestamptz := now();
BEGIN
  SELECT * INTO v_stream
    FROM public.live_streams
   WHERE id = p_stream_id
   FOR UPDATE;

  IF NOT FOUND OR v_stream.status <> 'live' THEN
    RETURN false;
  END IF;

  IF v_stream.creator_id <> p_creator_id THEN
    RAISE EXCEPTION 'only the creator can end this LIVE stream' USING ERRCODE = '42501';
  END IF;

  UPDATE public.live_streams
     SET status = 'ended', ended_at = v_now
   WHERE id = p_stream_id AND status = 'live';
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated = 0 THEN
    RETURN false;
  END IF;

  UPDATE public.live_stream_participants
     SET status = 'left', left_at = COALESCE(left_at, v_now)
   WHERE stream_id = p_stream_id AND status = 'joined';

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.create_live_stream(uuid, uuid, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.end_live_stream(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_live_stream(uuid, uuid, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.end_live_stream(uuid, uuid) TO service_role;

COMMIT;
