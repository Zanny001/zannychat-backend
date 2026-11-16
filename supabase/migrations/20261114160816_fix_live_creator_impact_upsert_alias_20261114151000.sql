-- Fix the conflict-update target alias in the LIVE creator impact writer.
-- Without an explicit INSERT target alias, repeated reactions for a creator fail.
CREATE OR REPLACE FUNCTION public.record_live_creator_impact(
  p_stream_id uuid,
  p_user_id uuid,
  p_reaction text
)
RETURNS TABLE (
  impact_score bigint,
  total_reactions bigint,
  unique_supporters bigint,
  score_awarded boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_creator_id uuid;
  v_supporter_rows integer := 0;
  v_daily_rows integer := 0;
BEGIN
  IF p_stream_id IS NULL OR p_user_id IS NULL OR p_reaction IS NULL
     OR p_reaction NOT IN ('heart','clap','laugh','wow','fire','idea','support') THEN
    RAISE EXCEPTION 'Invalid LIVE reaction' USING ERRCODE = '22023';
  END IF;

  SELECT s.creator_id INTO v_creator_id
  FROM public.live_streams s
  WHERE s.id = p_stream_id AND s.status = 'live';

  IF v_creator_id IS NULL THEN
    RAISE EXCEPTION 'LIVE stream is not active' USING ERRCODE = 'P0001';
  END IF;
  IF v_creator_id = p_user_id THEN
    RAISE EXCEPTION 'Creators cannot award themselves impact' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.live_stream_participants p
    WHERE p.stream_id = p_stream_id
      AND p.user_id = p_user_id
      AND p.status = 'joined'
      AND p.left_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Join this LIVE stream before reacting' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.live_stream_reactions (stream_id, user_id, reaction)
  VALUES (p_stream_id, p_user_id, p_reaction);

  INSERT INTO public.live_creator_impact_supporters (creator_id, supporter_id)
  VALUES (v_creator_id, p_user_id)
  ON CONFLICT (creator_id, supporter_id) DO NOTHING;
  GET DIAGNOSTICS v_supporter_rows = ROW_COUNT;

  INSERT INTO public.live_creator_impact_daily (creator_id, supporter_id, impact_day)
  VALUES (v_creator_id, p_user_id, (now() AT TIME ZONE 'UTC')::date)
  ON CONFLICT (creator_id, supporter_id, impact_day) DO NOTHING;
  GET DIAGNOSTICS v_daily_rows = ROW_COUNT;

  INSERT INTO public.live_creator_impact AS current_impact (
    creator_id, impact_score, total_reactions, unique_supporters, updated_at
  )
  VALUES (
    v_creator_id,
    CASE WHEN v_daily_rows > 0 THEN 1 ELSE 0 END,
    1,
    CASE WHEN v_supporter_rows > 0 THEN 1 ELSE 0 END,
    now()
  )
  ON CONFLICT (creator_id) DO UPDATE SET
    impact_score = current_impact.impact_score + EXCLUDED.impact_score,
    total_reactions = current_impact.total_reactions + 1,
    unique_supporters = current_impact.unique_supporters + EXCLUDED.unique_supporters,
    updated_at = now();

  RETURN QUERY
  SELECT i.impact_score, i.total_reactions, i.unique_supporters, (v_daily_rows > 0)
  FROM public.live_creator_impact i
  WHERE i.creator_id = v_creator_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.record_live_creator_impact(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_live_creator_impact(uuid, uuid, text) TO service_role;
