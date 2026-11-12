-- Regression assertions for the status-media Storage INSERT RLS policy.
-- The Storage API may not include metadata.size in the row at INSERT-check time.
DO $$
DECLARE
  v_check text;
  v_public boolean;
  v_size_limit bigint;
  v_mime_types text[];
BEGIN
  SELECT with_check INTO v_check
  FROM pg_policies
  WHERE schemaname = 'storage'
    AND tablename = 'objects'
    AND policyname = 'Status media owner uploads'
    AND cmd = 'INSERT';

  IF v_check IS NULL THEN
    RAISE EXCEPTION 'status-media owner upload policy is missing';
  END IF;
  IF position('metadata' IN lower(v_check)) > 0 THEN
    RAISE EXCEPTION 'status-media upload RLS must not depend on metadata being present';
  END IF;
  IF position('status_updates' IN lower(v_check)) = 0
     OR position('media_path' IN lower(v_check)) = 0
     OR position('foldername' IN lower(v_check)) = 0
     OR position('auth.uid' IN lower(v_check)) = 0
     OR position('expires_at' IN lower(v_check)) = 0 THEN
    RAISE EXCEPTION 'status-media upload policy lost its owner, path, or expiry checks';
  END IF;

  SELECT public, file_size_limit, allowed_mime_types
    INTO v_public, v_size_limit, v_mime_types
  FROM storage.buckets
  WHERE id = 'status-media';

  IF v_public IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'status-media bucket must remain private';
  END IF;
  IF v_size_limit <> 52428800 THEN
    RAISE EXCEPTION 'status-media bucket must retain its 50 MiB maximum';
  END IF;
  IF NOT ('video/mp4' = ANY(v_mime_types))
     OR NOT ('image/jpeg' = ANY(v_mime_types))
     OR NOT ('image/png' = ANY(v_mime_types))
     OR NOT ('image/webp' = ANY(v_mime_types)) THEN
    RAISE EXCEPTION 'status-media bucket MIME allowlist is incomplete';
  END IF;
END $$;
