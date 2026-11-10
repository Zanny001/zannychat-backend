BEGIN;
ALTER TABLE public.group_call_rooms
  ADD COLUMN IF NOT EXISTS call_type text NOT NULL DEFAULT 'audio'
  CHECK (call_type IN ('audio','video'));
COMMIT;