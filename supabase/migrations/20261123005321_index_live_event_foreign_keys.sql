-- Keep Auth-user cascade checks and per-user LIVE reminder cleanup indexed.
-- These indexes complement the existing event/user composite and pending-work indexes.
BEGIN;

CREATE INDEX IF NOT EXISTS live_event_invites_invited_by_idx
  ON public.live_event_invites (invited_by);

CREATE INDEX IF NOT EXISTS live_event_reminder_deliveries_user_id_idx
  ON public.live_event_reminder_deliveries (user_id);

COMMIT;
