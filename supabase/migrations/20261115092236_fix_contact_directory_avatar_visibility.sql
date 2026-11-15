-- Keep the legacy contact-directory projection aligned with private avatar
-- visibility. The no-argument overload delegates to this function.
BEGIN;

CREATE OR REPLACE FUNCTION public.get_contact_directory(p_user_id uuid DEFAULT NULL)
RETURNS TABLE (
  id uuid,
  name text,
  avatar_color text,
  avatar_url text,
  status text,
  online boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT
    p.id,
    p.name,
    p.avatar_color,
    CASE
      WHEN public.can_view_profile_avatar(p.id) THEN p.avatar_url
      ELSE NULL
    END,
    p.status,
    CASE
      WHEN COALESCE(d.show_online_status, true) THEN p.online
      ELSE false
    END
  FROM public.profiles AS p
  LEFT JOIN public.profile_details AS d
    ON d.user_id = p.id
  WHERE auth.uid() IS NOT NULL
    AND p.id <> auth.uid()
    AND (p_user_id IS NULL OR p.id = p_user_id)
    AND COALESCE(d.profile_visibility, 'everyone') <> 'nobody'
    AND EXISTS (
      SELECT 1
      FROM public.conversation_participants AS viewer_membership
      JOIN public.conversation_participants AS target_membership
        ON target_membership.conversation_id = viewer_membership.conversation_id
      WHERE viewer_membership.user_id = auth.uid()
        AND target_membership.user_id = p.id
    )
    AND NOT EXISTS (
      SELECT 1
      FROM public.blocked_users AS b
      WHERE (b.blocker_id = auth.uid() AND b.blocked_id = p.id)
         OR (b.blocker_id = p.id AND b.blocked_id = auth.uid())
    )
  ORDER BY p.name ASC, p.id ASC;
$function$;

REVOKE ALL ON FUNCTION public.get_contact_directory(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_contact_directory(uuid) TO authenticated;
COMMENT ON FUNCTION public.get_contact_directory(uuid) IS
  'Returns conversation-scoped contacts and delegates avatar visibility to can_view_profile_avatar, including contacts-only, nobody and bidirectional block rules.';

COMMIT;
