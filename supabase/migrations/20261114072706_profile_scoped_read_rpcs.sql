-- Add privacy-scoped profile read RPCs before the client switches away from direct table reads.
-- This additive migration is safe to deploy while existing clients still use the old projection.
BEGIN;

-- Full profile fields are available only to the signed-in owner.
CREATE OR REPLACE FUNCTION public.get_my_profile()
RETURNS TABLE (
  id uuid,
  name text,
  avatar_color text,
  avatar_url text,
  status text,
  online boolean,
  created_at timestamptz,
  username text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT p.id, p.name, p.avatar_color, p.avatar_url, p.status, p.online, p.created_at, p.username
  FROM public.profiles AS p
  WHERE p.id = auth.uid();
$function$;

REVOKE ALL ON FUNCTION public.get_my_profile() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_profile() TO authenticated;
COMMENT ON FUNCTION public.get_my_profile() IS
  'Returns the complete profile row only for the authenticated owner.';

-- Existing chat participants need display fields, but private avatar and
-- presence preferences must still be applied. This RPC is limited to IDs the
-- caller supplies AND shares a conversation with.
CREATE OR REPLACE FUNCTION public.get_conversation_profile_directory(p_user_ids uuid[])
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
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_viewer uuid := auth.uid();
BEGIN
  IF v_viewer IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;
  IF COALESCE(pg_catalog.cardinality(p_user_ids), 0) > 500 THEN
    RAISE EXCEPTION 'Too many profile IDs requested' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT
    p.id,
    p.name,
    p.username,
    p.avatar_color,
    CASE
      WHEN COALESCE(d.photo_visibility, 'everyone') = 'nobody'
        OR EXISTS (
          SELECT 1 FROM public.blocked_users AS b
          WHERE (b.blocker_id = v_viewer AND b.blocked_id = p.id)
             OR (b.blocker_id = p.id AND b.blocked_id = v_viewer)
        ) THEN NULL
      ELSE p.avatar_url
    END AS avatar_url,
    p.status,
    CASE
      WHEN COALESCE(d.show_online_status, true)
        AND NOT EXISTS (
          SELECT 1 FROM public.blocked_users AS b
          WHERE (b.blocker_id = v_viewer AND b.blocked_id = p.id)
             OR (b.blocker_id = p.id AND b.blocked_id = v_viewer)
        ) THEN p.online
      ELSE false
    END AS online
  FROM public.profiles AS p
  LEFT JOIN public.profile_details AS d ON d.user_id = p.id
  WHERE p.id <> v_viewer
    AND p.id = ANY(COALESCE(p_user_ids, ARRAY[]::uuid[]))
    AND EXISTS (
      SELECT 1
      FROM public.conversation_participants AS mine
      JOIN public.conversation_participants AS theirs
        ON theirs.conversation_id = mine.conversation_id
      WHERE mine.user_id = v_viewer
        AND theirs.user_id = p.id
    );
END;
$function$;

REVOKE ALL ON FUNCTION public.get_conversation_profile_directory(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_conversation_profile_directory(uuid[]) TO authenticated;
COMMENT ON FUNCTION public.get_conversation_profile_directory(uuid[]) IS
  'Returns privacy-filtered profile fields only for the caller and requested users who share a conversation.';

-- Search quotas are stored separately from phone-discovery quotas. No client
-- role can inspect or mutate this internal table directly.
CREATE TABLE IF NOT EXISTS public.people_search_limits (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  window_started_at timestamptz NOT NULL,
  request_count integer NOT NULL CHECK (request_count >= 0)
);
ALTER TABLE public.people_search_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.people_search_limits FROM PUBLIC, anon, authenticated;

-- Search only the public identity projection. Profile visibility, photo
-- visibility, shared-conversation contact scope, bidirectional blocks, and a
-- persistent per-user quota are enforced inside this SECURITY DEFINER RPC.
CREATE OR REPLACE FUNCTION public.search_people(
  p_query text,
  p_limit integer DEFAULT 20
)
RETURNS TABLE (
  id uuid,
  name text,
  username text,
  avatar_color text,
  avatar_url text
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_viewer uuid := auth.uid();
  v_query text;
  v_pattern text;
  v_window timestamptz := pg_catalog.date_trunc('minute', pg_catalog.clock_timestamp());
  v_request_count integer;
BEGIN
  IF v_viewer IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;

  v_query := pg_catalog.lower(pg_catalog.btrim(COALESCE(p_query, '')));
  IF pg_catalog.left(v_query, 1) = '@' THEN
    v_query := pg_catalog.substr(v_query, 2);
  END IF;
  IF pg_catalog.length(v_query) < 2 OR pg_catalog.length(v_query) > 40 THEN
    RETURN;
  END IF;

  -- Escape LIKE metacharacters so input is always a literal prefix.
  v_pattern := pg_catalog.replace(
    pg_catalog.replace(
      pg_catalog.replace(v_query, E'\\', E'\\\\'),
      '%',
      E'\\%'
    ),
    '_',
    E'\\_'
  ) || '%';

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
      WHEN COALESCE(d.photo_visibility, 'everyone') = 'nobody' THEN NULL
      WHEN COALESCE(d.photo_visibility, 'everyone') = 'contacts'
        AND NOT EXISTS (
          SELECT 1
          FROM public.conversation_participants AS mine
          JOIN public.conversation_participants AS theirs
            ON theirs.conversation_id = mine.conversation_id
          WHERE mine.user_id = v_viewer
            AND theirs.user_id = p.id
        ) THEN NULL
      ELSE p.avatar_url
    END AS avatar_url
  FROM public.profiles AS p
  LEFT JOIN public.profile_details AS d ON d.user_id = p.id
  WHERE p.id <> v_viewer
    AND (
      pg_catalog.lower(p.username) LIKE v_pattern ESCAPE E'\\'
      OR pg_catalog.lower(p.name) LIKE v_pattern ESCAPE E'\\'
    )
    AND COALESCE(d.profile_visibility, 'everyone') <> 'nobody'
    AND (
      COALESCE(d.profile_visibility, 'everyone') = 'everyone'
      OR (
        COALESCE(d.profile_visibility, 'everyone') = 'contacts'
        AND EXISTS (
          SELECT 1
          FROM public.conversation_participants AS mine
          JOIN public.conversation_participants AS theirs
            ON theirs.conversation_id = mine.conversation_id
          WHERE mine.user_id = v_viewer
            AND theirs.user_id = p.id
        )
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
      WHEN pg_catalog.lower(p.username) = v_query THEN 0
      WHEN pg_catalog.lower(p.username) LIKE v_pattern ESCAPE E'\\' THEN 1
      ELSE 2
    END,
    pg_catalog.lower(p.name),
    p.id
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 20), 25));
END;
$function$;

REVOKE ALL ON FUNCTION public.search_people(text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.search_people(text, integer) TO authenticated;
COMMENT ON FUNCTION public.search_people(text, integer) IS
  'Prefix-searches discoverable public identities only; excludes self and bidirectional blocks, limits output and enforces a persistent per-user search quota.';

COMMIT;
