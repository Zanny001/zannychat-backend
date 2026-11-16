-- Keep status-media compatible with native image/video picker MIME types
-- across Android, iOS, and web. The bucket remains private and its size limit
-- and RLS policies are unchanged.
BEGIN;

UPDATE storage.buckets
SET allowed_mime_types = ARRAY[
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/heic',
  'image/heif',
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'video/3gpp'
]
WHERE id = 'status-media';

COMMIT;
