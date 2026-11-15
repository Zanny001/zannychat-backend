-- Keep direct Storage uploads within the same limit enforced by ChatScreen.
-- A client-side check alone can be bypassed by any authenticated API client.
UPDATE storage.buckets
SET file_size_limit = 26214400
WHERE id = 'chat-media';

-- The private avatar bucket already enforces this limit and MIME set.
-- Mirror it on the legacy public bucket during the compatibility window.
UPDATE storage.buckets
SET file_size_limit = 10485760,
    allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp']
WHERE id = 'avatars';
