-- Read-only, identity-bound inventory of the caller's active Auth sessions.
-- Never expose IP addresses, refresh tokens, token HMAC material or session internals.
BEGIN;

CREATE OR REPLACE FUNCTION public.list_my_auth_sessions()
RETURNS TABLE (
  session_id uuid,
  created_at timestamptz,
  last_active_at timestamptz,
  not_after timestamptz,
  user_agent text,
  is_current boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
  SELECT
    s.id,
    s.created_at,
    COALESCE(s.refreshed_at AT TIME ZONE 'UTC', s.updated_at, s.created_at),
    s.not_after,
    NULLIF(left(s.user_agent, 256), ''),
    COALESCE(s.id = NULLIF(auth.jwt() ->> 'session_id', '')::uuid, false)
  FROM auth.sessions AS s
  WHERE s.user_id = auth.uid()
    AND (s.not_after IS NULL OR s.not_after > now())
    AND EXISTS (
      SELECT 1
      FROM auth.refresh_tokens AS rt
      WHERE rt.session_id = s.id
        AND rt.revoked = false
    )
  ORDER BY last_active_at DESC
  LIMIT 50;
$function$;

REVOKE ALL ON FUNCTION public.list_my_auth_sessions() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_my_auth_sessions() TO authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;
