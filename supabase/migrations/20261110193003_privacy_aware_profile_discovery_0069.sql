-- Privacy-aware profile discovery projection.
-- Preserve the historical return shape on a fresh migration chain, but do not
-- replace a different deployed signature: 0075 and the later privacy correction
-- own that transition when the function already exists.
DO $migration$
BEGIN
  IF to_regprocedure('public.get_contact_directory(uuid)') IS NULL THEN
    EXECUTE $create$
      CREATE FUNCTION public.get_contact_directory(p_user_id uuid DEFAULT NULL)
      RETURNS TABLE (id uuid, name text, avatar_color text, username text)
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
        IF p_user_id IS NOT NULL AND p_user_id = v_viewer THEN
          RAISE EXCEPTION 'Cannot discover your own profile' USING ERRCODE = '22023';
        END IF;

        RETURN QUERY
        SELECT p.id, p.name, p.avatar_color, p.username
        FROM public.profiles AS p
        LEFT JOIN public.profile_details AS d ON d.user_id = p.id
        WHERE p.id <> v_viewer
          AND (p_user_id IS NULL OR p.id = p_user_id)
          AND COALESCE(d.profile_visibility, 'everyone') <> 'nobody'
          AND (
            COALESCE(d.profile_visibility, 'everyone') = 'everyone'
            OR EXISTS (
              SELECT 1
              FROM public.conversation_participants AS mine
              JOIN public.conversation_participants AS theirs
                ON theirs.conversation_id = mine.conversation_id
              WHERE mine.user_id = v_viewer AND theirs.user_id = p.id
            )
          )
          AND NOT EXISTS (
            SELECT 1 FROM public.blocked_users AS b
            WHERE (b.blocker_id = v_viewer AND b.blocked_id = p.id)
               OR (b.blocker_id = p.id AND b.blocked_id = v_viewer)
          )
        ORDER BY p.name, p.id;
      END;
      $function$;
    $create$;
  END IF;
END;
$migration$;

REVOKE ALL ON FUNCTION public.get_contact_directory(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_contact_directory(uuid) TO authenticated;
COMMENT ON FUNCTION public.get_contact_directory(uuid) IS
  'Returns minimal identity fields for profiles visible to the caller; excludes self and either-direction blocks.';
