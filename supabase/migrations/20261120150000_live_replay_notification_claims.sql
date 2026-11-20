-- Make LIVE replay-ready push delivery recoverable across backend instances.
BEGIN;

ALTER TABLE public.live_stream_replays
  ADD COLUMN IF NOT EXISTS notification_claimed_at timestamptz,
  ADD COLUMN IF NOT EXISTS notification_claim_token uuid,
  ADD COLUMN IF NOT EXISTS notification_retry_after timestamptz;

CREATE OR REPLACE FUNCTION public.claim_live_replay_ready_notification(p_replay_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_claim_token uuid := gen_random_uuid();
BEGIN
  IF p_replay_id IS NULL THEN
    RETURN NULL;
  END IF;

  UPDATE public.live_stream_replays
  SET notification_claimed_at = now(),
      notification_claim_token = v_claim_token,
      updated_at = now()
  WHERE id = p_replay_id
    AND status = 'ready'
    AND notification_sent_at IS NULL
    AND (notification_retry_after IS NULL OR notification_retry_after <= now())
    AND (
      notification_claimed_at IS NULL
      OR notification_claimed_at < now() - interval '10 minutes'
    );

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  RETURN v_claim_token;
END;
$function$;

CREATE OR REPLACE FUNCTION public.complete_live_replay_ready_notification(
  p_replay_id uuid,
  p_claim_token uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
  IF p_replay_id IS NULL OR p_claim_token IS NULL THEN
    RETURN false;
  END IF;

  UPDATE public.live_stream_replays
  SET notification_sent_at = now(),
      notification_claimed_at = NULL,
      notification_claim_token = NULL,
      notification_retry_after = NULL,
      updated_at = now()
  WHERE id = p_replay_id
    AND status = 'ready'
    AND notification_sent_at IS NULL
    AND notification_claim_token = p_claim_token;

  RETURN FOUND;
END;
$function$;

CREATE OR REPLACE FUNCTION public.release_live_replay_ready_notification(
  p_replay_id uuid,
  p_claim_token uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
  IF p_replay_id IS NULL OR p_claim_token IS NULL THEN
    RETURN false;
  END IF;

  UPDATE public.live_stream_replays
  SET notification_claimed_at = NULL,
      notification_claim_token = NULL,
      notification_retry_after = now() + interval '10 minutes',
      updated_at = now()
  WHERE id = p_replay_id
    AND notification_sent_at IS NULL
    AND notification_claim_token = p_claim_token;

  RETURN FOUND;
END;
$function$;

REVOKE ALL ON FUNCTION public.claim_live_replay_ready_notification(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_live_replay_ready_notification(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_live_replay_ready_notification(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_live_replay_ready_notification(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_live_replay_ready_notification(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_live_replay_ready_notification(uuid, uuid) TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
