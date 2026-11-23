-- Persist LIVE discovery feedback without exposing it to client-side reads.
BEGIN;

CREATE TABLE IF NOT EXISTS public.live_stream_feedback (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  creator_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  feedback_type text NOT NULL CHECK (feedback_type IN ('not_interested')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, creator_id, feedback_type),
  CHECK (user_id <> creator_id)
);

CREATE INDEX IF NOT EXISTS live_stream_feedback_creator_idx
  ON public.live_stream_feedback (creator_id, user_id);

ALTER TABLE public.live_stream_feedback ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.live_stream_feedback FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.live_stream_feedback TO service_role;

COMMENT ON TABLE public.live_stream_feedback IS
  'Private, server-managed LIVE discovery feedback; never directly readable or writable by clients.';

COMMIT;
