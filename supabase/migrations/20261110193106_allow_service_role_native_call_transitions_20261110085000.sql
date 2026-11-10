-- Allow signed native-call reconciliation to perform only the terminal
-- transitions that its call-scoped HMAC token authorizes.
-- This is additive; it does not alter existing call rows or RLS policies.

BEGIN;

CREATE OR REPLACE FUNCTION public.validate_call_session_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor uuid := auth.uid();
  is_service_role boolean := COALESCE(auth.role() = 'service_role', false);
  member_count integer;
  total_count integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF actor IS NULL OR NEW.caller_id <> actor OR NEW.status <> 'ringing' THEN
      RAISE EXCEPTION 'invalid call creator or initial state' USING ERRCODE = '42501';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(LEAST(NEW.caller_id::text, NEW.callee_id::text), 0));
    PERFORM pg_advisory_xact_lock(hashtextextended(GREATEST(NEW.caller_id::text, NEW.callee_id::text), 0));
    IF EXISTS (
      SELECT 1 FROM public.call_sessions c
      WHERE ((c.status = 'accepted' AND c.last_activity_at > now() - interval '3 minutes')
        OR (c.status = 'ringing' AND c.expires_at > now()))
        AND (c.caller_id IN (NEW.caller_id, NEW.callee_id) OR c.callee_id IN (NEW.caller_id, NEW.callee_id))
    ) THEN
      RAISE EXCEPTION 'a participant is already in an active call' USING ERRCODE = '23505';
    END IF;
    SELECT count(*) INTO member_count FROM public.conversation_participants cp
      WHERE cp.conversation_id = NEW.conversation_id AND cp.user_id IN (NEW.caller_id, NEW.callee_id);
    SELECT count(*) INTO total_count FROM public.conversation_participants cp WHERE cp.conversation_id = NEW.conversation_id;
    IF member_count <> 2 OR total_count <> 2 THEN
      RAISE EXCEPTION 'calls are supported only between the two members of a direct conversation' USING ERRCODE = '42501';
    END IF;
    IF EXISTS (SELECT 1 FROM public.blocked_users b
      WHERE (b.blocker_id = NEW.caller_id AND b.blocked_id = NEW.callee_id)
         OR (b.blocker_id = NEW.callee_id AND b.blocked_id = NEW.caller_id)) THEN
      RAISE EXCEPTION 'calls are unavailable for this contact' USING ERRCODE = '42501';
    END IF;
    NEW.last_activity_at := now();
    RETURN NEW;
  END IF;

  IF NEW.id <> OLD.id OR NEW.conversation_id <> OLD.conversation_id
     OR NEW.caller_id <> OLD.caller_id OR NEW.callee_id <> OLD.callee_id
     OR NEW.call_type <> OLD.call_type OR NEW.created_at <> OLD.created_at
     OR NEW.expires_at <> OLD.expires_at THEN
    RAISE EXCEPTION 'call identity fields are immutable' USING ERRCODE = '42501';
  END IF;
  IF actor IS NULL THEN
    IF NOT is_service_role AND current_user <> 'postgres' THEN
      RAISE EXCEPTION 'not a call participant' USING ERRCODE = '42501';
    END IF;
  ELSIF actor NOT IN (OLD.caller_id, OLD.callee_id) AND NOT is_service_role THEN
    RAISE EXCEPTION 'not a call participant' USING ERRCODE = '42501';
  END IF;

  IF NEW.status = OLD.status THEN
    IF NEW.accepted_at IS DISTINCT FROM OLD.accepted_at OR NEW.ended_at IS DISTINCT FROM OLD.ended_at THEN
      RAISE EXCEPTION 'call lifecycle timestamps are immutable outside a state transition' USING ERRCODE = '42501';
    END IF;
    IF NEW.last_activity_at IS DISTINCT FROM OLD.last_activity_at
       AND (OLD.status <> 'accepted' OR NEW.last_activity_at < OLD.last_activity_at
         OR NEW.last_activity_at > now() + interval '10 seconds') THEN
      RAISE EXCEPTION 'invalid call heartbeat lease' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'ringing' AND NEW.status = 'missed'
     AND (actor IN (OLD.caller_id, OLD.callee_id) OR is_service_role OR (actor IS NULL AND current_user = 'postgres')) THEN
    IF now() < OLD.expires_at THEN
      RAISE EXCEPTION 'call invitation has not expired' USING ERRCODE = '42501';
    END IF;
    NEW.accepted_at := OLD.accepted_at;
    NEW.ended_at := now();
  ELSIF OLD.status = 'ringing' AND NEW.status IN ('accepted', 'declined')
     AND (actor = OLD.callee_id OR (is_service_role AND NEW.status = 'declined')) THEN
    IF now() > OLD.expires_at THEN
      NEW.status := 'missed';
      NEW.accepted_at := OLD.accepted_at;
      NEW.ended_at := now();
    ELSIF NEW.status = 'accepted' THEN
      NEW.accepted_at := now();
      NEW.ended_at := OLD.ended_at;
      NEW.last_activity_at := now();
    ELSE
      NEW.accepted_at := OLD.accepted_at;
      NEW.ended_at := now();
    END IF;
  ELSIF OLD.status = 'ringing' AND NEW.status = 'cancelled' AND actor = OLD.caller_id THEN
    IF now() >= OLD.expires_at THEN NEW.status := 'missed'; END IF;
    NEW.accepted_at := OLD.accepted_at;
    NEW.ended_at := now();
  ELSIF OLD.status = 'accepted' AND NEW.status = 'ended'
     AND (actor IN (OLD.caller_id, OLD.callee_id) OR is_service_role) THEN
    NEW.accepted_at := OLD.accepted_at;
    NEW.ended_at := now();
  ELSE
    RAISE EXCEPTION 'invalid call state transition' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

NOTIFY pgrst, 'reload schema';
COMMIT;
