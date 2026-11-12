-- Cover the recipient foreign key for account deletion and recipient lookups.
CREATE INDEX IF NOT EXISTS call_end_notifications_recipient_id_idx
  ON public.call_end_notifications (recipient_id);
