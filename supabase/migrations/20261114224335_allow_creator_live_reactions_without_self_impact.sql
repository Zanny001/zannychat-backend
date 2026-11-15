-- Allow creators to send LIVE reactions without awarding themselves impact.
-- Viewer reactions continue to award creator impact under the existing anti-abuse rules.

CREATE OR REPLACE FUNCTION public.record_live_creator_impact(p_stream_id uuid, p_user_id uuid, p_reaction text)
RETURNS TABLE(impact_score bigint, total_reactions bigint, unique_supporters bigint, score_awarded boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
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

  -- Creators may react for on-screen expression, but their own reactions
  -- must never generate creator impact or supporter credit.
  IF v_creator_id <> p_user_id AND NOT EXISTS (
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

  IF v_creator_id = p_user_id THEN
    RETURN QUERY
    SELECT COALESCE(i.impact_score, 0),
           COALESCE(i.total_reactions, 0),
           COALESCE(i.unique_supporters, 0),
           false
    FROM (SELECT 1) AS anchor
    LEFT JOIN public.live_creator_impact i ON i.creator_id = v_creator_id;
    RETURN;
  END IF;

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

CREATE OR REPLACE FUNCTION public.get_live_creator_reaction_breakdown(p_creator_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path TO ''
AS $function$
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object('reaction', reaction_counts.reaction, 'count', reaction_counts.reaction_count)
      ORDER BY reaction_counts.reaction_count DESC, reaction_counts.reaction
    ),
    '[]'::jsonb
  )
  FROM (
    SELECT reactions.reaction, count(*)::bigint AS reaction_count
      FROM public.live_stream_reactions AS reactions
      INNER JOIN public.live_streams AS streams ON streams.id = reactions.stream_id
     WHERE streams.creator_id = p_creator_id
       AND reactions.user_id <> streams.creator_id
     GROUP BY reactions.reaction
  ) AS reaction_counts;
$function$;
