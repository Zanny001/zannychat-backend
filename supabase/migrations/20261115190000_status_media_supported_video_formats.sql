-- Keep status-media aligned with the formats the app can upload and play.
-- H.264/AAC QuickTime MOV and MP4 are supported; WebM/3GPP are not yet
-- guaranteed across both native players, so do not advertise them.
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
  'video/quicktime'
]
WHERE id = 'status-media';

COMMIT;
