-- Backfill creator impact from reactions recorded before the impact ledger was introduced.
-- The cutoff is the production application time of 20261114085407_live_creator_impact_score.
-- New reactions are accounted for transactionally by record_live_creator_impact().
WITH legacy_reactions AS (
  SELECT
    streams.creator_id,
    reactions.user_id AS supporter_id,
    reactions.created_at,
    (reactions.created_at AT TIME ZONE 'UTC')::date AS impact_day
  FROM public.live_stream_reactions AS reactions
  INNER JOIN public.live_streams AS streams
    ON streams.id = reactions.stream_id
  WHERE reactions.created_at < timestamptz '2026-11-14 08:54:07+00'
    AND streams.creator_id <> reactions.user_id
),
supporters_inserted AS (
  INSERT INTO public.live_creator_impact_supporters (
    creator_id, supporter_id, first_supported_at
  )
  SELECT creator_id, supporter_id, min(created_at)
  FROM legacy_reactions
  GROUP BY creator_id, supporter_id
  ON CONFLICT (creator_id, supporter_id) DO NOTHING
  RETURNING creator_id
),
daily_inserted AS (
  INSERT INTO public.live_creator_impact_daily (
    creator_id, supporter_id, impact_day
  )
  SELECT DISTINCT creator_id, supporter_id, impact_day
  FROM legacy_reactions
  ON CONFLICT (creator_id, supporter_id, impact_day) DO NOTHING
  RETURNING creator_id
),
reaction_totals AS (
  SELECT creator_id, count(*)::bigint AS total_reactions
  FROM legacy_reactions
  GROUP BY creator_id
),
new_supporter_totals AS (
  SELECT creator_id, count(*)::bigint AS unique_supporters
  FROM supporters_inserted
  GROUP BY creator_id
),
new_daily_totals AS (
  SELECT creator_id, count(*)::bigint AS impact_score
  FROM daily_inserted
  GROUP BY creator_id
)
INSERT INTO public.live_creator_impact AS current_impact (
  creator_id, impact_score, total_reactions, unique_supporters, updated_at
)
SELECT
  totals.creator_id,
  COALESCE(daily.impact_score, 0),
  totals.total_reactions,
  COALESCE(supporters.unique_supporters, 0),
  now()
FROM reaction_totals AS totals
LEFT JOIN new_daily_totals AS daily USING (creator_id)
LEFT JOIN new_supporter_totals AS supporters USING (creator_id)
ON CONFLICT (creator_id) DO UPDATE SET
  impact_score = current_impact.impact_score + EXCLUDED.impact_score,
  total_reactions = current_impact.total_reactions + EXCLUDED.total_reactions,
  unique_supporters = current_impact.unique_supporters + EXCLUDED.unique_supporters,
  updated_at = now();
