-- Add creator-appointed LIVE moderators and durable report review metadata.
BEGIN;

CREATE TABLE IF NOT EXISTS public.live_stream_moderators (
  stream_id uuid NOT NULL REFERENCES public.live_streams(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  appointed_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (stream_id, user_id),
  CHECK (user_id <> appointed_by)
);

CREATE INDEX IF NOT EXISTS live_stream_moderators_user_idx
  ON public.live_stream_moderators(user_id, created_at DESC);

ALTER TABLE public.live_stream_reports
  ADD COLUMN IF NOT EXISTS reviewed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.live_stream_reports
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;

ALTER TABLE public.live_stream_moderators ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.live_stream_moderators FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.live_stream_moderators TO service_role;

COMMENT ON TABLE public.live_stream_moderators IS
  'Creator-appointed moderators for a single LIVE stream. All access is mediated by authenticated backend routes.';
COMMENT ON COLUMN public.live_stream_reports.reviewed_by IS
  'Authenticated creator or appointed LIVE moderator who last reviewed this report.';

COMMIT;
