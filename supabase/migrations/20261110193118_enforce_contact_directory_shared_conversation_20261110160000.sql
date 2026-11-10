-- Enforce contact-directory and QR-target privacy at the RPC boundary.
-- Requires 0066_profile_privacy_and_attachment_cleanup.sql first, because this
-- function reads the owner's profile_visibility/photo_visibility preferences.
-- Shared-conversation access is intentionally required for both directory and QR.
BEGIN;

-- 0069 may have created a different return shape, while 0075 added a separate
-- zero-argument wrapper. Drop both signatures before changing the TABLE shape.
DROP FUNCTION IF EXISTS public.get_contact_directory();
DROP FUNCTION IF EXISTS public.get_contact_directory(uuid);

CREATE FUNCTION public.get_contact_directory(p_user_id uuid)
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
      WHEN COALESCE(d.photo_visibility, 'everyone') = 'nobody' THEN NULL
      ELSE p.avatar_url
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

CREATE FUNCTION public.get_contact_directory()
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
  SELECT *
  FROM public.get_contact_directory(NULL::uuid);
$function$;

REVOKE ALL ON FUNCTION public.get_contact_directory() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_contact_directory(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_contact_directory() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_contact_directory(uuid) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
