-- Add a call-scoped claim overload. Existing one-argument service-role
-- workers remain compatible; the API route uses p_call_id to avoid draining
-- other users' queued invitations when one caller kicks delivery.
BEGIN;

CREATE OR REPLACE FUNCTION public.claim_call_invitation_notifications(
  p_limit integer,
  p_call_id uuid
)
RETURNS TABLE(call_id uuid, caller_id uuid, callee_id uuid, attempt_count integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RETURN QUERY
  WITH candidates AS (
    SELECT q.call_id
    FROM public.call_invitation_notifications q
    WHERE (
      (q.status = 'pending' AND q.next_attempt_at <= now())
      OR (q.status = 'processing' AND q.lease_started_at < now() - interval '5 minutes')
    )
      AND (p_call_id IS NULL OR q.call_id = p_call_id)
    ORDER BY q.next_attempt_at, q.created_at
    FOR UPDATE SKIP LOCKED
    LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 20), 100))
  )
  UPDATE public.call_invitation_notifications q
     SET status = 'processing', lease_started_at = now()
    FROM candidates c
   WHERE q.call_id = c.call_id
  RETURNING q.call_id, q.caller_id, q.callee_id, q.attempt_count;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_call_invitation_notifications(integer, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_call_invitation_notifications(integer, uuid) TO service_role;

COMMIT;
