-- Keep the bidirectional call-renegotiation trigger on an empty search path.
-- All application relations and auth helpers are schema-qualified.
CREATE OR REPLACE FUNCTION public.validate_call_signal_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  c public.call_sessions%rowtype;
  recent_count integer;
BEGIN
  IF auth.uid() IS NULL OR new.sender_id <> auth.uid() THEN
    RAISE EXCEPTION 'invalid signal sender' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO c FROM public.call_sessions WHERE id = new.call_id;
  IF NOT FOUND OR c.status <> 'accepted'
     OR now() > COALESCE(c.accepted_at, c.created_at) + interval '8 hours' THEN
    RAISE EXCEPTION 'call is not available for renegotiation' USING ERRCODE = '42501';
  END IF;

  IF NOT ((new.sender_id = c.caller_id AND new.recipient_id = c.callee_id)
       OR (new.sender_id = c.callee_id AND new.recipient_id = c.caller_id)) THEN
    RAISE EXCEPTION 'signal recipient is not the other participant' USING ERRCODE = '42501';
  END IF;

  IF new.signal_type NOT IN ('offer', 'answer', 'ice-candidate') THEN
    RAISE EXCEPTION 'unsupported call signal type' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(new.call_id::text || ':' || new.sender_id::text, 0));
  SELECT count(*) INTO recent_count FROM public.call_signals
    WHERE call_id = new.call_id AND sender_id = new.sender_id AND created_at > now() - interval '1 minute';
  IF recent_count >= 120 THEN
    RAISE EXCEPTION 'call signaling rate exceeded' USING ERRCODE = '54000';
  END IF;
  RETURN new;
END;
$$;

REVOKE ALL ON FUNCTION public.validate_call_signal_insert() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.validate_call_signal_insert() TO service_role;
