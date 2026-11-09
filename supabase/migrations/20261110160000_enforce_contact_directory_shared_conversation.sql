-- Restrict contact-directory and QR-target lookups to users who share a conversation.
-- This is a corrective migration: the original RPC was restored without the
-- shared-conversation predicate, despite its privacy contract.
BEGIN;

CREATE OR REPLACE FUNCTION public.get_contact_directory(p_user_id uuid)
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
    p.avatar_url,
    p.status,
    p.online
  FROM public.profiles AS p
  WHERE auth.uid() IS NOT NULL
    AND p.id <> auth.uid()
    AND (p_user_id IS NULL OR p.id = p_user_id)
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

-- Preserve the existing least-privilege RPC grants and refresh PostgREST.
REVOKE ALL ON FUNCTION public.get_contact_directory(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_contact_directory(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_contact_directory(uuid) TO service_role;
NOTIFY pgrst, 'reload schema';

COMMIT;
