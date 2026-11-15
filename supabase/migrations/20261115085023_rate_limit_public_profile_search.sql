CREATE OR REPLACE FUNCTION public.search_public_profiles(
  p_query text,
  p_limit integer DEFAULT 20,
  p_offset integer DEFAULT 0
)
RETURNS TABLE (
  id uuid,
  name text,
  username text,
  avatar_color text,
  avatar_url text,
  status text,
  online boolean
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_viewer uuid := auth.uid();
  v_query text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_query, '')));
  v_limit integer := greatest(1, least(coalesce(p_limit, 20), 30));
  v_offset integer := greatest(0, least(coalesce(p_offset, 0), 1000));
  v_window timestamptz := pg_catalog.date_trunc('minute', pg_catalog.clock_timestamp());
  v_request_count integer;
BEGIN
  IF v_viewer IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;

  IF pg_catalog.length(v_query) < 2 OR pg_catalog.length(v_query) > 40 THEN
    RETURN;
  END IF;

  -- Share the same per-user quota as search_people so the legacy RPC cannot
  -- bypass the newer, rate-limited people-search endpoint.
  INSERT INTO public.people_search_limits (user_id, window_started_at, request_count)
  VALUES (v_viewer, v_window, 1)
  ON CONFLICT (user_id) DO UPDATE
    SET window_started_at = CASE
          WHEN public.people_search_limits.window_started_at < v_window THEN v_window
          ELSE public.people_search_limits.window_started_at
        END,
        request_count = CASE
          WHEN public.people_search_limits.window_started_at < v_window THEN 1
          ELSE public.people_search_limits.request_count + 1
        END
  RETURNING request_count INTO v_request_count;

  IF v_request_count > 30 THEN
    RAISE EXCEPTION 'People search rate limit exceeded' USING ERRCODE = '42900';
  END IF;

  RETURN QUERY
  SELECT
    p.id,
    p.name,
    p.username,
    p.avatar_color,
    CASE
      WHEN public.can_view_profile_avatar(p.id) THEN p.avatar_url
      ELSE NULL
    END,
    p.status,
    CASE
      WHEN coalesce(d.show_online_status, true) THEN p.online
      ELSE false
    END
  FROM public.profiles AS p
  LEFT JOIN public.profile_details AS d ON d.user_id = p.id
  WHERE p.id <> v_viewer
    AND (
      pg_catalog.left(pg_catalog.lower(p.username), pg_catalog.length(v_query)) = v_query
      OR position(v_query in pg_catalog.lower(p.name)) > 0
    )
    AND coalesce(d.profile_visibility, 'everyone') <> 'nobody'
    AND (
      coalesce(d.profile_visibility, 'everyone') <> 'contacts'
      OR EXISTS (
        SELECT 1
        FROM public.conversation_participants AS mine
        JOIN public.conversation_participants AS theirs
          ON theirs.conversation_id = mine.conversation_id
        WHERE mine.user_id = v_viewer
          AND theirs.user_id = p.id
      )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM public.blocked_users AS b
      WHERE (b.blocker_id = v_viewer AND b.blocked_id = p.id)
         OR (b.blocker_id = p.id AND b.blocked_id = v_viewer)
    )
  ORDER BY
    CASE
      WHEN pg_catalog.left(pg_catalog.lower(p.username), pg_catalog.length(v_query)) = v_query THEN 0
      ELSE 1
    END,
    p.name ASC,
    p.id ASC
  LIMIT v_limit
  OFFSET v_offset;
END;
$function$;

REVOKE ALL ON FUNCTION public.search_public_profiles(text, integer, integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.search_public_profiles(text, integer, integer)
  TO authenticated;
