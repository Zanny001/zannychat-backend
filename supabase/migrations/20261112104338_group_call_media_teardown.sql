-- Track SFU teardown independently from the durable group-call record.
-- The backend worker retries rooms whose database lifecycle ended but whose
-- LiveKit media room has not yet been confirmed deleted.
BEGIN;

ALTER TABLE public.group_call_rooms
  ADD COLUMN IF NOT EXISTS media_terminated_at timestamptz;

CREATE INDEX IF NOT EXISTS group_call_rooms_pending_media_teardown_idx
  ON public.group_call_rooms (ended_at, id)
  WHERE status = 'ended' AND media_terminated_at IS NULL;

COMMIT;
