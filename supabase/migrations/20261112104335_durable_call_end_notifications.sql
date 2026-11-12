-- Durable retry queue for native call-ended delivery.
BEGIN;

CREATE TABLE IF NOT EXISTS public.call_end_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id uuid NOT NULL REFERENCES public.call_sessions(id) ON DELETE CASCADE,
  recipient_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  terminal_status text NOT NULL CHECK (terminal_status IN ('declined','cancelled','ended','missed','failed')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','delivered','expired')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_started_at timestamptz,
  delivered_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (call_id, recipient_id)
);

ALTER TABLE public.call_end_notifications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.call_end_notifications FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.call_end_notifications TO service_role;

CREATE INDEX IF NOT EXISTS call_end_notifications_due_idx
  ON public.call_end_notifications (next_attempt_at, created_at)
  WHERE status = 'pending';

CREATE OR REPLACE FUNCTION public.claim_call_end_notifications(
  p_limit integer DEFAULT 20,
  p_call_id uuid DEFAULT NULL
)
RETURNS SETOF public.call_end_notifications
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH due AS (
    SELECT n.id
      FROM public.call_end_notifications n
     WHERE (p_call_id IS NULL OR n.call_id = p_call_id)
       AND (
         (n.status = 'pending' AND n.next_attempt_at <= now())
         OR (n.status = 'processing' AND n.lease_started_at <= now() - interval '2 minutes')
       )
     ORDER BY n.created_at, n.id
     FOR UPDATE SKIP LOCKED
     LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 20), 100))
  )
  UPDATE public.call_end_notifications n
     SET status = 'processing', lease_started_at = now()
    FROM due
   WHERE n.id = due.id
  RETURNING n.*;
$$;

REVOKE ALL ON FUNCTION public.claim_call_end_notifications(integer, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_call_end_notifications(integer, uuid) TO service_role;

COMMIT;
