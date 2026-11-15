-- Durable retry queue for personal Storage objects after account deletion.
-- Deliberately has no FK to auth.users so it survives the user cascade.
BEGIN;

CREATE TABLE IF NOT EXISTS public.account_storage_cleanup_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error text
);

CREATE INDEX IF NOT EXISTS account_storage_cleanup_jobs_due_idx
  ON public.account_storage_cleanup_jobs (next_attempt_at, created_at);

ALTER TABLE public.account_storage_cleanup_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.account_storage_cleanup_jobs FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.account_storage_cleanup_jobs TO service_role;

COMMIT;
