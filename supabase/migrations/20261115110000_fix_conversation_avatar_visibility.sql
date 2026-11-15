-- Ensure conversation profile projections use the same photo visibility
-- rules as private Storage reads and public profile lookup.
BEGIN;

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
      WHEN public.can_view_profile_avatar(p.id) THEN p.avatar_url
      ELSE NULL
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
  'Returns conversation-scoped profile fields and delegates avatar visibility to can_view_profile_avatar, including contacts-only, nobody, and bidirectional block rules.';

COMMIT;
