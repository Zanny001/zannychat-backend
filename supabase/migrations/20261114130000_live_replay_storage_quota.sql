-- Private, quota-limited LIVE replay metadata and server-only storage.
BEGIN;

CREATE TABLE IF NOT EXISTS public.live_stream_replays (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stream_id uuid NOT NULL REFERENCES public.live_streams(id) ON DELETE CASCADE,
  creator_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  egress_id text UNIQUE,
  file_path text UNIQUE,
  status text NOT NULL DEFAULT 'starting'
    CHECK (status IN ('starting','recording','processing','ready','failed','deleted')),
  duration_seconds integer NOT NULL DEFAULT 0 CHECK (duration_seconds BETWEEN 0 AND 300),
  file_size_bytes bigint NOT NULL DEFAULT 0 CHECK (file_size_bytes BETWEEN 0 AND 52428800),
  error_code text,
  started_at timestamptz,
  completed_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS live_stream_replays_one_active_per_stream
  ON public.live_stream_replays(stream_id)
  WHERE status IN ('starting','recording','processing','ready');
CREATE INDEX IF NOT EXISTS live_stream_replays_stream_created_idx
  ON public.live_stream_replays(stream_id, created_at DESC);
CREATE INDEX IF NOT EXISTS live_stream_replays_creator_created_idx
  ON public.live_stream_replays(creator_id, created_at DESC);
CREATE INDEX IF NOT EXISTS live_stream_replays_expiry_idx
  ON public.live_stream_replays(expires_at)
  WHERE status IN ('ready','failed');

ALTER TABLE public.live_stream_replays ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.live_stream_replays FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.live_stream_replays TO service_role;

CREATE TABLE IF NOT EXISTS public.live_replay_quota (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  month_start date NOT NULL,
  reserved_seconds integer NOT NULL DEFAULT 0 CHECK (reserved_seconds BETWEEN 0 AND 3000),
  used_seconds integer NOT NULL DEFAULT 0 CHECK (used_seconds BETWEEN 0 AND 3000),
  active_replay_id uuid REFERENCES public.live_stream_replays(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.live_replay_quota ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.live_replay_quota FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.live_replay_quota TO service_role;

CREATE OR REPLACE FUNCTION public.reserve_live_replay_quota(p_replay_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_month_start date := date_trunc('month', now())::date;
BEGIN
  IF p_replay_id IS NULL THEN
    RAISE EXCEPTION 'Replay id is required';
  END IF;

  INSERT INTO public.live_replay_quota(singleton, month_start)
  VALUES (true, v_month_start)
  ON CONFLICT (singleton) DO NOTHING;

  UPDATE public.live_replay_quota
  SET month_start = v_month_start,
      reserved_seconds = 0,
      used_seconds = 0,
      active_replay_id = NULL,
      updated_at = now()
  WHERE singleton = true
    AND month_start <> v_month_start
    AND active_replay_id IS NULL;

  UPDATE public.live_replay_quota
  SET reserved_seconds = reserved_seconds + 300,
      active_replay_id = p_replay_id,
      updated_at = now()
  WHERE singleton = true
    AND month_start = v_month_start
    AND active_replay_id IS NULL
    AND reserved_seconds + used_seconds + 300 <= 3000;

  RETURN FOUND;
END;
$function$;

CREATE OR REPLACE FUNCTION public.finalize_live_replay_quota(
  p_replay_id uuid,
  p_actual_seconds integer,
  p_success boolean
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF p_replay_id IS NULL THEN
    RAISE EXCEPTION 'Replay id is required';
  END IF;

  UPDATE public.live_replay_quota
  SET reserved_seconds = greatest(reserved_seconds - 300, 0),
      used_seconds = used_seconds + CASE
        WHEN coalesce(p_success, false)
          THEN least(greatest(coalesce(p_actual_seconds, 0), 0), 300)
        ELSE 0
      END,
      active_replay_id = NULL,
      updated_at = now()
  WHERE singleton = true
    AND active_replay_id = p_replay_id;

  RETURN FOUND;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_live_replay_storage_bytes()
RETURNS bigint
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT coalesce(sum(nullif(metadata->>'size', '')::bigint), 0)::bigint
  FROM storage.objects
  WHERE bucket_id = 'live-replays';
$function$;

REVOKE ALL ON FUNCTION public.get_live_replay_storage_bytes() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_live_replay_storage_bytes() TO service_role;

REVOKE ALL ON FUNCTION public.reserve_live_replay_quota(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finalize_live_replay_quota(uuid, integer, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_live_replay_quota(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.finalize_live_replay_quota(uuid, integer, boolean) TO service_role;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('live-replays', 'live-replays', false, 52428800, ARRAY['video/mp4'])
ON CONFLICT (id) DO UPDATE
SET public = false,
    file_size_limit = 52428800,
    allowed_mime_types = ARRAY['video/mp4'];

COMMIT;
