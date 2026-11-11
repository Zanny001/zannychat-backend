BEGIN;

-- Supabase Storage evaluates INSERT RLS before the object row is committed.
-- The Storage API does not guarantee metadata.size is populated at this point,
-- so requiring it makes valid uploads fail with SQLSTATE 42501.
-- Keep the security boundary on authenticated ownership, exact status path,
-- active status row, media kind, and extension. The bucket enforces 50 MiB max
-- size and the allowed MIME types; the client additionally caps photos at 10 MiB.

UPDATE storage.buckets
SET public = false,
    file_size_limit = 52428800,
    allowed_mime_types = ARRAY['image/jpeg','image/png','image/webp','video/mp4']::text[]
WHERE id = 'status-media';

DROP POLICY IF EXISTS "Status media owner uploads" ON storage.objects;

CREATE POLICY "Status media owner uploads"
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'status-media'
  AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
  AND EXISTS (
    SELECT 1
    FROM public.status_updates s
    WHERE s.id::text = (storage.foldername(objects.name))[2]
      AND s.user_id = (SELECT auth.uid())
      AND s.media_kind IN ('image', 'video')
      AND s.media_path = objects.name
      AND s.expires_at > now()
      AND (
        (
          s.media_kind = 'image'
          AND objects.name = s.user_id::text || '/' || s.id::text || '/photo.' || storage.extension(objects.name)
          AND storage.extension(objects.name) IN ('jpg', 'png', 'webp')
        )
        OR
        (
          s.media_kind = 'video'
          AND objects.name = (SELECT auth.uid())::text || '/' || s.id::text || '/video.mp4'
          AND storage.extension(objects.name) = 'mp4'
        )
      )
  )
);

COMMIT;
