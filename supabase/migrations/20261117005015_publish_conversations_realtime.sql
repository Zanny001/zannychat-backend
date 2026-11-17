-- Publish conversation metadata changes so focused inboxes can refresh titles
-- and avatars. RLS remains authoritative for all delivered row events.
BEGIN;

ALTER PUBLICATION supabase_realtime
  ADD TABLE public.conversations;

COMMIT;
