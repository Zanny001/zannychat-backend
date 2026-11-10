-- Restore the authenticated RPCs used by the web and mobile chat clients.
-- The older 0069 migration returns a different TABLE shape. Drop both contact
-- directory signatures before recreating them with the deployed projection.
BEGIN;

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
    p.avatar_url,
    p.status,
    p.online
  FROM public.profiles AS p
  WHERE auth.uid() IS NOT NULL
    AND p.id <> auth.uid()
    AND (p_user_id IS NULL OR p.id = p_user_id)
    AND NOT EXISTS (
      SELECT 1
      FROM public.blocked_users AS b
      WHERE (b.blocker_id = auth.uid() AND b.blocked_id = p.id)
         OR (b.blocker_id = p.id AND b.blocked_id = auth.uid())
    )
  ORDER BY p.name ASC, p.id ASC;
$function$;

-- PostgREST needs a true zero-argument signature for rpc('get_contact_directory').
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

CREATE OR REPLACE FUNCTION public.get_my_read_cursors()
RETURNS TABLE (
  conversation_id uuid,
  last_read_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT cp.conversation_id, cp.last_read_at
  FROM public.conversation_participants AS cp
  WHERE auth.uid() IS NOT NULL
    AND cp.user_id = auth.uid()
    AND cp.last_read_at IS NOT NULL
  ORDER BY cp.conversation_id;
$function$;

REVOKE ALL ON FUNCTION public.get_my_read_cursors() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_read_cursors() TO authenticated;

-- Refresh PostgREST's schema cache so both zero-argument RPCs are discoverable.
NOTIFY pgrst, 'reload schema';

COMMIT;
