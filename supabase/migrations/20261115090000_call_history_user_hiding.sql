-- Per-user call-history hiding. The underlying call remains visible to
-- the other participant and is retained for call lifecycle/audit integrity.
BEGIN;
CREATE TABLE IF NOT EXISTS public.call_history_hidden (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  call_id uuid NOT NULL,
  call_kind text NOT NULL CHECK (call_kind IN ('direct','group')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, call_id, call_kind)
);
ALTER TABLE public.call_history_hidden ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.call_history_hidden FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.call_history_hidden TO service_role;
CREATE INDEX IF NOT EXISTS call_history_hidden_user_recent_idx
  ON public.call_history_hidden(user_id, created_at DESC);
COMMENT ON TABLE public.call_history_hidden IS
  'Per-user hidden call-history records; hiding never erases another participant history.';
COMMIT;
