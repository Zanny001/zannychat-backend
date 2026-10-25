-- ZannyChat migration compatibility repair.
--
-- Historical migration-ID collision:
--   * The older backend line used version 0046 for channel-post idempotency.
--   * Canonical 1.2.237 uses 0046 for server-enforced Status expiry and moves
--     channel-post idempotency to 0048.
-- A database that recorded the older 0046 may therefore skip the canonical
-- Status-expiry migration when applying by version. This additive migration
-- reasserts the canonical expiry behavior without changing or renumbering any
-- previously released migration. Safe on both older and clean canonical DBs.

ALTER TABLE public.status_updates
  DROP CONSTRAINT IF EXISTS status_expiry_window;
ALTER TABLE public.status_updates
  ADD CONSTRAINT status_expiry_window
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '48 hours');

CREATE OR REPLACE FUNCTION public.enforce_status_expiry_window()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  requested_seconds double precision;
  server_created_at timestamptz;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
      RAISE EXCEPTION 'Status creation and expiry timestamps cannot be changed after publishing.';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.created_at IS NULL OR NEW.expires_at IS NULL THEN
    RAISE EXCEPTION 'A supported Status expiry must be selected.';
  END IF;

  requested_seconds := extract(epoch FROM (NEW.expires_at - NEW.created_at));
  IF NOT (
    abs(requested_seconds - 21600) < 1
    OR abs(requested_seconds - 43200) < 1
    OR abs(requested_seconds - 86400) < 1
    OR abs(requested_seconds - 172800) < 1
  ) THEN
    RAISE EXCEPTION 'Status expiry must be 6, 12, 24, or 48 hours.';
  END IF;

  server_created_at := clock_timestamp();
  NEW.created_at := server_created_at;
  NEW.expires_at := server_created_at + make_interval(secs => requested_seconds::integer);
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.enforce_status_expiry_window() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS enforce_status_expiry_window ON public.status_updates;
CREATE TRIGGER enforce_status_expiry_window
BEFORE INSERT OR UPDATE OF created_at, expires_at ON public.status_updates
FOR EACH ROW EXECUTE FUNCTION public.enforce_status_expiry_window();

DROP POLICY IF EXISTS "Users can publish own statuses" ON public.status_updates;
CREATE POLICY "Users can publish own statuses" ON public.status_updates
FOR INSERT TO authenticated
WITH CHECK (
  user_id = (SELECT auth.uid())
  AND expires_at > now()
  AND expires_at <= created_at + interval '48 hours'
  AND (
    (media_kind IS NULL AND media_path IS NULL AND text IS NOT NULL AND char_length(btrim(text)) BETWEEN 1 AND 700)
    OR (media_kind = 'image' AND media_path = 'pending' AND char_length(btrim(coalesce(text, ''))) <= 700)
    OR (media_kind = 'video' AND media_path = 'pending' AND char_length(btrim(coalesce(text, ''))) <= 700)
  )
);

DROP POLICY IF EXISTS "Users can update own media status path" ON public.status_updates;
CREATE POLICY "Users can update own media status path" ON public.status_updates
FOR UPDATE TO authenticated
USING (user_id = (SELECT auth.uid()))
WITH CHECK (
  user_id = (SELECT auth.uid())
  AND expires_at > now()
  AND expires_at <= created_at + interval '48 hours'
  AND (
    (media_kind = 'image' AND media_path = user_id::text || '/' || id::text || '/photo.' || split_part(media_path, '.', 2)
      AND split_part(media_path, '.', 2) IN ('jpg', 'png', 'webp'))
    OR (media_kind = 'video' AND media_path = user_id::text || '/' || id::text || '/video.mp4')
  )
);
