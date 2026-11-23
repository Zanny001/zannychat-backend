BEGIN;
ALTER TABLE public.live_purchase_risk_events
  ADD COLUMN IF NOT EXISTS provider_due_at timestamptz;
CREATE INDEX IF NOT EXISTS live_purchase_risk_events_open_dispute_due_idx
  ON public.live_purchase_risk_events(provider_due_at)
  WHERE status = 'open' AND event_type LIKE 'charge.dispute.%' AND provider_due_at IS NOT NULL;
COMMENT ON COLUMN public.live_purchase_risk_events.provider_due_at IS
  'Paystack provider-supplied dispute response deadline; used for operator prioritization.';
COMMIT;
