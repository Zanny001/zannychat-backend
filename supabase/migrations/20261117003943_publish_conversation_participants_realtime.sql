-- Publish conversation participant changes so authenticated clients can receive
-- read-state, membership and inbox invalidation events. RLS remains authoritative.
BEGIN;

ALTER PUBLICATION supabase_realtime
  ADD TABLE public.conversation_participants;

COMMIT;
