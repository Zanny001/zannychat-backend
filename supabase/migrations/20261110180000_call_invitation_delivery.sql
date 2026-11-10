-- Durable, idempotent call invitation queue for background/closed-app push delivery.
-- Realtime remains the foreground fast path; the authenticated backend kick
-- sends queued invitations immediately after the caller creates a session.

BEGIN;

CREATE TABLE IF NOT EXISTS public.call_invitation_notifications (
  call_id uuid PRIMARY KEY REFERENCES public.call_sessions(id) ON DELETE CASCADE,
  caller_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  callee_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','processing','delivered','expired')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_started_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz
);

CREATE INDEX IF NOT EXISTS call_invitation_notifications_due_idx
  ON public.call_invitation_notifications(status, next_attempt_at, created_at);

ALTER TABLE public.call_invitation_notifications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.call_invitation_notifications FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.call_invitation_notifications TO service_role;

CREATE OR REPLACE FUNCTION public.enqueue_call_invitation_notification()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.status = 'ringing' THEN
    INSERT INTO public.call_invitation_notifications(call_id, caller_id, callee_id)
    VALUES (NEW.id, NEW.caller_id, NEW.callee_id)
    ON CONFLICT (call_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_call_session_created_notify ON public.call_sessions;
CREATE TRIGGER on_call_session_created_notify
  AFTER INSERT ON public.call_sessions
  FOR EACH ROW EXECUTE FUNCTION public.enqueue_call_invitation_notification();

CREATE OR REPLACE FUNCTION public.claim_call_invitation_notifications(p_limit integer DEFAULT 20)
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
    WHERE (q.status = 'pending' AND q.next_attempt_at <= now())
       OR (q.status = 'processing' AND q.lease_started_at < now() - interval '5 minutes')
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

REVOKE ALL ON FUNCTION public.enqueue_call_invitation_notification() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_call_invitation_notifications(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_call_invitation_notifications(integer) TO service_role;

COMMIT;
