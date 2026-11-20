-- Index the remaining LIVE Event foreign-key columns.
-- These support Auth-user cascade checks and owner/user cleanup lookups.
BEGIN;

CREATE INDEX IF NOT EXISTS live_event_invites_invited_by_idx
  ON public.live_event_invites (invited_by);

CREATE INDEX IF NOT EXISTS live_event_reminder_deliveries_user_id_idx
  ON public.live_event_reminder_deliveries (user_id);

COMMIT;
