-- Scheduled LIVE Events with private RSVP records and atomic capacity enforcement.
BEGIN;

CREATE TABLE IF NOT EXISTS public.live_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 80),
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 1000),
  category text NOT NULL DEFAULT 'social'
    CHECK (category IN ('entertainment','social','politics','science','education','finance','technology','sports','business','health','other')),
  visibility text NOT NULL DEFAULT 'public'
    CHECK (visibility IN ('public','followers','private')),
  starts_at timestamptz NOT NULL,
  duration_minutes integer NOT NULL DEFAULT 60 CHECK (duration_minutes BETWEEN 15 AND 240),
  status text NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled','cancelled','live','ended')),
  stream_id uuid REFERENCES public.live_streams(id) ON DELETE SET NULL,
  max_attendees integer NOT NULL DEFAULT 500 CHECK (max_attendees BETWEEN 1 AND 500),
  reminder_sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.live_event_attendees (
  event_id uuid NOT NULL REFERENCES public.live_events(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'going' CHECK (status IN ('going','cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id,user_id)
);

CREATE TABLE IF NOT EXISTS public.live_event_invites (
  event_id uuid NOT NULL REFERENCES public.live_events(id) ON DELETE CASCADE,
  invited_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  invited_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined','revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id,invited_user_id)
);

CREATE INDEX IF NOT EXISTS live_event_invites_user_idx
  ON public.live_event_invites(invited_user_id,status,created_at DESC);

CREATE INDEX IF NOT EXISTS live_events_upcoming_idx
  ON public.live_events(starts_at ASC) WHERE status = 'scheduled';
CREATE INDEX IF NOT EXISTS live_events_creator_idx
  ON public.live_events(creator_id,starts_at DESC);
CREATE INDEX IF NOT EXISTS live_event_attendees_user_idx
  ON public.live_event_attendees(user_id,status,created_at DESC);

ALTER TABLE public.live_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.live_event_attendees ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.live_event_invites ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.live_events FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.live_event_attendees FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.live_event_invites FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.live_events TO service_role;
GRANT ALL ON public.live_event_attendees TO service_role;
GRANT ALL ON public.live_event_invites TO service_role;

CREATE OR REPLACE FUNCTION public.rsvp_live_event(p_event_id uuid, p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_event public.live_events%ROWTYPE;
  v_existing public.live_event_attendees%ROWTYPE;
  v_count integer;
BEGIN
  SELECT * INTO v_event FROM public.live_events WHERE id = p_event_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('result','not_found');
  END IF;
  IF v_event.status <> 'scheduled' OR v_event.starts_at <= now() THEN
    RETURN jsonb_build_object('result','closed');
  END IF;
  IF v_event.creator_id = p_user_id THEN
    RETURN jsonb_build_object('result','creator');
  END IF;

  SELECT * INTO v_existing FROM public.live_event_attendees
    WHERE event_id = p_event_id AND user_id = p_user_id;
  SELECT count(*)::integer INTO v_count FROM public.live_event_attendees
    WHERE event_id = p_event_id AND status = 'going';
  IF v_existing.status = 'going' THEN
    RETURN jsonb_build_object('result','already_going','attendee_count',v_count);
  END IF;
  IF v_count >= v_event.max_attendees THEN
    RETURN jsonb_build_object('result','full','attendee_count',v_count);
  END IF;

  INSERT INTO public.live_event_attendees(event_id,user_id,status,updated_at)
    VALUES(p_event_id,p_user_id,'going',now())
    ON CONFLICT(event_id,user_id) DO UPDATE
      SET status='going',updated_at=now();
  RETURN jsonb_build_object('result','going','attendee_count',v_count + 1);
END;
$$;

REVOKE ALL ON FUNCTION public.rsvp_live_event(uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rsvp_live_event(uuid,uuid) TO service_role;


CREATE OR REPLACE FUNCTION public.attach_live_event_stream(p_event_id uuid, p_stream_id uuid, p_creator_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $
DECLARE
  v_event public.live_events%ROWTYPE;
  v_stream public.live_streams%ROWTYPE;
BEGIN
  SELECT * INTO v_event FROM public.live_events WHERE id=p_event_id FOR UPDATE;
  IF NOT FOUND OR v_event.creator_id <> p_creator_id THEN RETURN false; END IF;
  SELECT * INTO v_stream FROM public.live_streams WHERE id=p_stream_id FOR UPDATE;
  IF NOT FOUND OR v_stream.creator_id <> p_creator_id OR v_stream.status <> 'live' THEN RETURN false; END IF;
  IF v_event.stream_id = p_stream_id AND v_event.status = 'live' THEN RETURN true; END IF;
  IF v_event.status <> 'scheduled' OR v_event.stream_id IS NOT NULL
    OR v_event.starts_at > now() + interval '60 minutes'
    OR v_event.starts_at + make_interval(mins => v_event.duration_minutes) < now() THEN
    RETURN false;
  END IF;
  UPDATE public.live_events
    SET stream_id=p_stream_id,status='live',updated_at=now()
    WHERE id=p_event_id;
  RETURN true;
END;
$;

REVOKE ALL ON FUNCTION public.attach_live_event_stream(uuid,uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.attach_live_event_stream(uuid,uuid,uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.sync_live_event_after_stream_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $
BEGIN
  IF NEW.status = 'ended' AND OLD.status IS DISTINCT FROM NEW.status THEN
    UPDATE public.live_events SET status='ended',updated_at=now()
      WHERE stream_id=NEW.id AND status='live';
  END IF;
  RETURN NEW;
END;
$;

DROP TRIGGER IF EXISTS live_event_stream_end_sync ON public.live_streams;
CREATE TRIGGER live_event_stream_end_sync
  AFTER UPDATE OF status ON public.live_streams
  FOR EACH ROW EXECUTE FUNCTION public.sync_live_event_after_stream_update();

COMMIT;
