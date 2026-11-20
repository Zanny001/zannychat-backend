-- Durable leases for scheduled cleanup and LIVE timeout-warning work.
-- A crashed process releases work automatically after the bounded lease.
BEGIN;

ALTER TABLE public.account_storage_cleanup_jobs
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz;
CREATE INDEX IF NOT EXISTS account_storage_cleanup_jobs_claimed_due_idx
  ON public.account_storage_cleanup_jobs (claimed_at, next_attempt_at, created_at)
  WHERE status IN ('held', 'pending');

ALTER TABLE public.group_call_rooms
  ADD COLUMN IF NOT EXISTS media_cleanup_claimed_at timestamptz;
CREATE INDEX IF NOT EXISTS group_call_rooms_pending_media_claim_idx
  ON public.group_call_rooms (media_cleanup_claimed_at, ended_at, id)
  WHERE status = 'ended' AND media_terminated_at IS NULL;

ALTER TABLE public.live_streams
  ADD COLUMN IF NOT EXISTS timeout_warning_claimed_at timestamptz;
CREATE INDEX IF NOT EXISTS live_streams_timeout_warning_claim_idx
  ON public.live_streams (timeout_warning_claimed_at, started_at)
  WHERE status = 'live' AND timeout_warning_sent_at IS NULL;

CREATE OR REPLACE FUNCTION public.claim_live_stream_timeout_warnings()
RETURNS TABLE (recipient_id uuid, broadcast_id uuid, broadcast_title text)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO ''
AS $function$
  UPDATE public.live_streams AS s
     SET timeout_warning_claimed_at = now()
   WHERE s.status = 'live'
     AND s.started_at IS NOT NULL
     AND s.started_at <= now() - interval '3 hours 50 minutes'
     AND s.started_at > now() - interval '4 hours'
     AND s.timeout_warning_sent_at IS NULL
     AND (s.timeout_warning_claimed_at IS NULL
          OR s.timeout_warning_claimed_at < now() - interval '10 minutes')
  RETURNING s.creator_id, s.id, s.title;
$function$;

CREATE OR REPLACE FUNCTION public.mark_live_stream_timeout_warning_sent(p_broadcast_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_marked integer := 0;
BEGIN
  UPDATE public.live_streams
     SET timeout_warning_sent_at = now(),
         timeout_warning_claimed_at = NULL
   WHERE id = p_broadcast_id
     AND status = 'live'
     AND timeout_warning_sent_at IS NULL
     AND timeout_warning_claimed_at IS NOT NULL;
  GET DIAGNOSTICS v_marked = ROW_COUNT;
  RETURN v_marked > 0;
END;
$function$;

CREATE OR REPLACE FUNCTION public.release_live_stream_timeout_warning(p_broadcast_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_released integer := 0;
BEGIN
  UPDATE public.live_streams
     SET timeout_warning_claimed_at = NULL
   WHERE id = p_broadcast_id
     AND status = 'live'
     AND timeout_warning_sent_at IS NULL
     AND timeout_warning_claimed_at IS NOT NULL;
  GET DIAGNOSTICS v_released = ROW_COUNT;
  RETURN v_released > 0;
END;
$function$;

REVOKE ALL ON FUNCTION public.claim_live_stream_timeout_warnings() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_live_stream_timeout_warning_sent(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_live_stream_timeout_warning(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_live_stream_timeout_warnings() TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_live_stream_timeout_warning_sent(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_live_stream_timeout_warning(uuid) TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
