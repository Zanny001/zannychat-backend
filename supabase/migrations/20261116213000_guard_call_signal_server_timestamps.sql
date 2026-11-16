-- Make call signaling rate limits independent of client-supplied timestamps.
BEGIN;

CREATE OR REPLACE FUNCTION public.validate_call_signal_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  c public.call_sessions%rowtype;
  recent_count integer;
BEGIN
  IF auth.uid() IS NULL OR NEW.sender_id <> auth.uid() THEN
    RAISE EXCEPTION 'invalid signal sender' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO c
  FROM public.call_sessions
  WHERE id = NEW.call_id;

  IF NOT FOUND
     OR c.status <> 'accepted'
     OR pg_catalog.clock_timestamp() > COALESCE(c.accepted_at, c.created_at) + interval '8 hours' THEN
    RAISE EXCEPTION 'call is not available for renegotiation' USING ERRCODE = '42501';
  END IF;

  IF NOT (
    (NEW.sender_id = c.caller_id AND NEW.recipient_id = c.callee_id)
    OR (NEW.sender_id = c.callee_id AND NEW.recipient_id = c.caller_id)
  ) THEN
    RAISE EXCEPTION 'signal recipient is not the other participant' USING ERRCODE = '42501';
  END IF;

  IF NEW.signal_type NOT IN ('offer', 'answer', 'ice-candidate') THEN
    RAISE EXCEPTION 'unsupported call signal type' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(NEW.call_id::text || ':' || NEW.sender_id::text, 0)
  );

  -- Stamp after acquiring the per-call lock so the one-minute window is based
  -- on database time at the actual rate-limit check, never the client payload.
  NEW.created_at := pg_catalog.clock_timestamp();

  SELECT count(*) INTO recent_count
  FROM public.call_signals
  WHERE call_id = NEW.call_id
    AND sender_id = NEW.sender_id
    AND created_at > NEW.created_at - interval '1 minute';

  IF recent_count >= 120 THEN
    RAISE EXCEPTION 'call signaling rate exceeded' USING ERRCODE = '54000';
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.validate_call_signal_insert()
  FROM PUBLIC, anon, authenticated;

COMMIT;
