-- ZannyChat LIVE creator impact: transparent supporter-day score and reaction totals.
-- One impact point per distinct supporter per creator per UTC day; every reaction remains counted separately.
ALTER TABLE public.live_stream_reactions
  DROP CONSTRAINT IF EXISTS live_stream_reactions_reaction_check;
ALTER TABLE public.live_stream_reactions
  ADD CONSTRAINT live_stream_reactions_reaction_check
  CHECK (reaction = ANY (ARRAY['heart','clap','laugh','wow','fire','idea','support']::text[]));

CREATE TABLE IF NOT EXISTS public.live_creator_impact (
  creator_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  impact_score bigint NOT NULL DEFAULT 0 CHECK (impact_score >= 0),
  total_reactions bigint NOT NULL DEFAULT 0 CHECK (total_reactions >= 0),
  unique_supporters bigint NOT NULL DEFAULT 0 CHECK (unique_supporters >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.live_creator_impact_supporters (
  creator_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  supporter_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  first_supported_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (creator_id, supporter_id),
  CHECK (creator_id <> supporter_id)
);

CREATE TABLE IF NOT EXISTS public.live_creator_impact_daily (
  creator_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  supporter_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  impact_day date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (creator_id, supporter_id, impact_day),
  CHECK (creator_id <> supporter_id)
);

CREATE INDEX IF NOT EXISTS live_creator_impact_daily_day_idx
  ON public.live_creator_impact_daily (creator_id, impact_day DESC);

ALTER TABLE public.live_creator_impact ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.live_creator_impact_supporters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.live_creator_impact_daily ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.live_creator_impact FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.live_creator_impact_supporters FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.live_creator_impact_daily FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.live_creator_impact TO service_role;
GRANT ALL ON TABLE public.live_creator_impact_supporters TO service_role;
GRANT ALL ON TABLE public.live_creator_impact_daily TO service_role;

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

  INSERT INTO public.live_creator_impact (
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
    impact_score = public.live_creator_impact.impact_score + EXCLUDED.impact_score,
    total_reactions = public.live_creator_impact.total_reactions + 1,
    unique_supporters = public.live_creator_impact.unique_supporters + EXCLUDED.unique_supporters,
    updated_at = now();

  RETURN QUERY
  SELECT i.impact_score, i.total_reactions, i.unique_supporters, (v_daily_rows > 0)
  FROM public.live_creator_impact i
  WHERE i.creator_id = v_creator_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.record_live_creator_impact(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_live_creator_impact(uuid, uuid, text) TO service_role;
