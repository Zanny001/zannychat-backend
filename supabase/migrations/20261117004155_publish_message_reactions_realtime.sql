-- Publish RLS-protected message reaction changes for live reaction sync.
BEGIN;

ALTER PUBLICATION supabase_realtime
  ADD TABLE public.message_reactions;

COMMIT;
