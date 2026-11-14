DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'live_stream_replays' AND c.relrowsecurity
  ) THEN
    RAISE EXCEPTION 'live_stream_replays must have RLS enabled';
  END IF;
  IF has_table_privilege('authenticated', 'public.live_stream_replays', 'SELECT')
     OR has_table_privilege('authenticated', 'public.live_replay_quota', 'SELECT') THEN
    RAISE EXCEPTION 'authenticated users must not read replay metadata or quota tables directly';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.reserve_live_replay_quota(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.reserve_live_replay_quota(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.reserve_live_replay_quota(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'replay quota reservation must be service-role only';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM storage.buckets
    WHERE id = 'live-replays' AND public = false AND file_size_limit = 52428800
  ) THEN
    RAISE EXCEPTION 'private live-replays bucket with 50 MB cap is missing';
  END IF;
END;
$$;
