-- Allow iOS native image picker formats for profile avatars and covers.
-- Both buckets keep their current privacy settings, size limits, and RLS.
BEGIN;

UPDATE storage.buckets
SET allowed_mime_types = ARRAY[
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif'
]
WHERE id IN ('avatars', 'private-avatars');

COMMIT;
