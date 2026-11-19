-- Bound every LIVE session to four hours, even while its creator keeps
-- heartbeating. A separate idempotent claim sends the creator a ten-minute
-- warning before the hard deadline. Existing streams are evaluated from their
-- original started_at; no stream is silently extended by this migration.

ALTER TABLE public.live_streams
  ADD COLUMN IF NOT EXISTS timeout_warning_sent_at timestamptz;

CREATE INDEX IF NOT EXISTS live_streams_timeout_warning_due_idx
  ON public.live_streams (started_at)
  WHERE status = 'live' AND timeout_warning_sent_at IS NULL;

CREATE OR REPLACE FUNCTION public.claim_live_stream_timeout_warnings()
RETURNS TABLE (recipient_id uuid, broadcast_id uuid, broadcast_title text)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO ''
AS $function$
  UPDATE public.live_streams AS s
     SET timeout_warning_sent_at = now()
   WHERE s.status = 'live'
     AND s.started_at IS NOT NULL
     AND s.started_at <= now() - interval '3 hours 50 minutes'
     AND s.started_at > now() - interval '4 hours'
     AND s.timeout_warning_sent_at IS NULL
  RETURNING s.creator_id, s.id, s.title;
$function$;

REVOKE ALL ON FUNCTION public.claim_live_stream_timeout_warnings() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_live_stream_timeout_warnings() TO service_role;

-- Failed push delivery releases the claim so the worker can retry. A
-- successfully delivered warning remains claimed and cannot be duplicated.
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
     SET timeout_warning_sent_at = NULL
   WHERE id = p_broadcast_id
     AND status = 'live'
     AND timeout_warning_sent_at IS NOT NULL;
  GET DIAGNOSTICS v_released = ROW_COUNT;
  RETURN v_released > 0;
END;
$function$;

REVOKE ALL ON FUNCTION public.release_live_stream_timeout_warning(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_live_stream_timeout_warning(uuid) TO service_role;

-- The existing stale-heartbeat behavior remains unchanged. The additional
-- started_at predicate is the hard maximum-duration backstop.
CREATE OR REPLACE FUNCTION public.cleanup_stale_media_participants(p_stale_before timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_live_streams_ended integer := 0;
  v_live_participants_left integer := 0;
  v_group_participants_left integer := 0;
  v_group_rooms_ended integer := 0;
BEGIN
  IF p_stale_before IS NULL OR p_stale_before > now() THEN
    RAISE EXCEPTION 'invalid stale participant cutoff' USING ERRCODE = '22023';
  END IF;

  UPDATE public.live_streams s
     SET status = 'ended', ended_at = COALESCE(s.ended_at, now())
   WHERE s.status = 'live'
     AND (
       s.started_at <= now() - interval '4 hours'
       OR EXISTS (
         SELECT 1
           FROM public.live_stream_participants creator
          WHERE creator.stream_id = s.id
            AND creator.user_id = s.creator_id
            AND creator.role = 'creator'
            AND creator.status = 'joined'
            AND creator.last_seen_at < p_stale_before
       )
     );
  GET DIAGNOSTICS v_live_streams_ended = ROW_COUNT;

  UPDATE public.live_stream_participants p
     SET status = 'left', left_at = COALESCE(p.left_at, now()), last_seen_at = now()
   WHERE p.status = 'joined'
     AND (
       (p.role IN ('viewer','guest') AND p.last_seen_at < p_stale_before)
       OR EXISTS (
         SELECT 1 FROM public.live_streams s
          WHERE s.id = p.stream_id AND s.status = 'ended'
       )
     );
  GET DIAGNOSTICS v_live_participants_left = ROW_COUNT;

  UPDATE public.group_call_participants p
     SET status = 'left', left_at = COALESCE(p.left_at, now()), last_seen_at = now()
   WHERE p.status = 'joined'
     AND p.last_seen_at < p_stale_before;
  GET DIAGNOSTICS v_group_participants_left = ROW_COUNT;

  UPDATE public.group_call_rooms r
     SET status = 'ended', ended_at = COALESCE(r.ended_at, now())
   WHERE r.status = 'active'
     AND NOT EXISTS (
       SELECT 1 FROM public.group_call_participants p
        WHERE p.room_id = r.id AND p.status = 'joined'
     );
  GET DIAGNOSTICS v_group_rooms_ended = ROW_COUNT;

  RETURN pg_catalog.jsonb_build_object(
    'liveStreamsEnded', v_live_streams_ended,
    'liveParticipantsLeft', v_live_participants_left,
    'groupParticipantsLeft', v_group_participants_left,
    'groupRoomsEnded', v_group_rooms_ended
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.cleanup_stale_media_participants(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_stale_media_participants(timestamptz) TO service_role;

NOTIFY pgrst, 'reload schema';
