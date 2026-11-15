-- Enforce the same 25 MiB ceiling as the chat attachment UI at the
-- Storage service boundary. Client checks are usability only and can be bypassed.
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'chat-media') THEN
    RAISE EXCEPTION 'chat-media storage bucket must exist before applying its upload limit';
  END IF;
  UPDATE storage.buckets
     SET file_size_limit = 26214400
   WHERE id = 'chat-media';
END;
$migration$;
