-- Fix PL/pgSQL output-parameter ambiguity when claiming LIVE Event reminders.
-- The RETURNS TABLE output columns event_id/user_id shadow unqualified
-- ON CONFLICT column names. Resolve the conflict target by its primary-key constraint.
BEGIN;

CREATE OR REPLACE FUNCTION public.claim_live_event_reminders(p_limit integer DEFAULT 50)
RETURNS TABLE(event_id uuid,user_id uuid,event_title text,starts_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO public.live_event_reminder_deliveries(event_id,user_id)
  SELECT e.id, recipients.user_id
  FROM public.live_events e
  JOIN (
    SELECT e.id AS event_id,e.creator_id AS user_id FROM public.live_events e
      WHERE e.status='scheduled' AND e.starts_at>now() AND e.starts_at<=now()+interval '15 minutes'
    UNION
    SELECT a.event_id,a.user_id FROM public.live_event_attendees a WHERE a.status='going'
    UNION
    SELECT i.event_id,i.invited_user_id AS user_id FROM public.live_event_invites i WHERE i.status='accepted'
  ) recipients ON recipients.event_id=e.id
  WHERE e.status='scheduled' AND e.starts_at>now()
    AND e.starts_at<=now()+interval '15 minutes'
  ON CONFLICT ON CONSTRAINT live_event_reminder_deliveries_pkey DO NOTHING;

  RETURN QUERY
  WITH candidates AS (
    SELECT d.event_id,d.user_id
    FROM public.live_event_reminder_deliveries d
    JOIN public.live_events e ON e.id=d.event_id
    WHERE e.status='scheduled' AND e.starts_at>now()
      AND e.starts_at<=now()+interval '15 minutes'
      AND (
        e.creator_id=d.user_id
        OR EXISTS (SELECT 1 FROM public.live_event_attendees a WHERE a.event_id=d.event_id AND a.user_id=d.user_id AND a.status='going')
        OR EXISTS (SELECT 1 FROM public.live_event_invites i WHERE i.event_id=d.event_id AND i.invited_user_id=d.user_id AND i.status='accepted')
      )
      AND (
        e.creator_id=d.user_id
        OR e.visibility='public'
        OR (e.visibility='followers' AND EXISTS (
          SELECT 1 FROM public.live_creator_follows f
          WHERE f.creator_id=e.creator_id AND f.follower_id=d.user_id
        ))
        OR (e.visibility='private' AND EXISTS (
          SELECT 1 FROM public.live_event_invites i
          WHERE i.event_id=d.event_id AND i.invited_user_id=d.user_id
            AND i.status IN ('pending','accepted')
        ))
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.blocked_users b
        WHERE (b.blocker_id=e.creator_id AND b.blocked_id=d.user_id)
           OR (b.blocker_id=d.user_id AND b.blocked_id=e.creator_id)
      )
      AND (
        d.status IN ('pending','failed')
        OR (d.status='sending' AND d.claimed_at<now()-interval '10 minutes')
      )
    ORDER BY e.starts_at,d.created_at
    LIMIT LEAST(GREATEST(COALESCE(p_limit,50),1),100)
    FOR UPDATE OF d SKIP LOCKED
  ), claimed AS (
    UPDATE public.live_event_reminder_deliveries d
    SET status='sending',attempts=d.attempts+1,claimed_at=now(),updated_at=now(),last_error=NULL
    FROM candidates c
    WHERE d.event_id=c.event_id AND d.user_id=c.user_id
    RETURNING d.event_id,d.user_id
  )
  SELECT c.event_id,c.user_id,e.title,e.starts_at
  FROM claimed c JOIN public.live_events e ON e.id=c.event_id;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_live_event_reminders(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_live_event_reminders(integer) TO service_role;

COMMIT;
