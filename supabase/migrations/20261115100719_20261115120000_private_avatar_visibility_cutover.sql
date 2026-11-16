-- Complete the private-avatar authorization path without breaking public-avatar
-- compatibility for profiles whose profile and photo visibility are both public.
BEGIN;

CREATE OR REPLACE FUNCTION public.can_view_profile_avatar(p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_viewer uuid := auth.uid();
  v_photo_visibility text := 'everyone';
  v_profile_visibility text := 'everyone';
  v_is_contact boolean := false;
BEGIN
  IF v_viewer IS NULL OR p_user_id IS NULL THEN
    RETURN false;
  END IF;

  IF v_viewer = p_user_id THEN
    RETURN true;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.blocked_users AS b
    WHERE (b.blocker_id = v_viewer AND b.blocked_id = p_user_id)
       OR (b.blocker_id = p_user_id AND b.blocked_id = v_viewer)
  ) THEN
    RETURN false;
  END IF;

  SELECT
    COALESCE(d.photo_visibility, 'everyone'),
    COALESCE(d.profile_visibility, 'everyone')
  INTO v_photo_visibility, v_profile_visibility
  FROM public.profile_details AS d
  WHERE d.user_id = p_user_id;

  v_photo_visibility := COALESCE(v_photo_visibility, 'everyone');
  v_profile_visibility := COALESCE(v_profile_visibility, 'everyone');

  IF v_photo_visibility = 'nobody' OR v_profile_visibility = 'nobody' THEN
    RETURN false;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.conversation_participants AS viewer_membership
    JOIN public.conversation_participants AS target_membership
      ON target_membership.conversation_id = viewer_membership.conversation_id
    WHERE viewer_membership.user_id = v_viewer
      AND target_membership.user_id = p_user_id
  )
  INTO v_is_contact;

  IF (v_photo_visibility = 'contacts' OR v_profile_visibility = 'contacts')
     AND NOT v_is_contact THEN
    RETURN false;
  END IF;

  RETURN true;
END;
$function$;

REVOKE ALL ON FUNCTION public.can_view_profile_avatar(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_view_profile_avatar(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_visible_profile_avatar_paths(p_user_ids uuid[])
RETURNS TABLE (
  user_id uuid,
  avatar_path text,
  can_view boolean,
  requires_private boolean
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
    p.id AS user_id,
    CASE
      WHEN public.can_view_profile_avatar(p.id) THEN d.avatar_path
      ELSE NULL
    END AS avatar_path,
    public.can_view_profile_avatar(p.id) AS can_view,
    (
      COALESCE(d.profile_visibility, 'everyone') <> 'everyone'
      OR COALESCE(d.photo_visibility, 'everyone') <> 'everyone'
    ) AS requires_private
  FROM public.profiles AS p
  LEFT JOIN public.profile_details AS d ON d.user_id = p.id
  WHERE p.id = ANY(COALESCE(p_user_ids, ARRAY[]::uuid[]));
END;
$function$;

REVOKE ALL ON FUNCTION public.get_visible_profile_avatar_paths(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_visible_profile_avatar_paths(uuid[]) TO authenticated;

COMMENT ON FUNCTION public.can_view_profile_avatar(uuid) IS
  'Checks bidirectional blocks, profile visibility, photo visibility, and shared-conversation access before exposing an avatar.';
COMMENT ON FUNCTION public.get_visible_profile_avatar_paths(uuid[]) IS
  'Returns bounded, viewer-authorized private avatar paths for profile IDs; private paths are never returned when the viewer cannot see the avatar.';

COMMIT;
