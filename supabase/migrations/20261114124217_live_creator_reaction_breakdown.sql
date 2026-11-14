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
     GROUP BY reactions.reaction
  ) AS reaction_counts;
$function$;

REVOKE ALL ON FUNCTION public.get_live_creator_reaction_breakdown(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_live_creator_reaction_breakdown(uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_live_creator_reaction_breakdown(uuid) TO service_role;
