-- Preserve actual Google Play gross price and platform fee on each purchase.
-- This is separate from the NGN Sparks package price catalogue.
BEGIN;

ALTER TABLE public.live_spark_purchases
  ADD COLUMN IF NOT EXISTS provider_fee_minor bigint NOT NULL DEFAULT 0
  CHECK (provider_fee_minor >= 0 AND provider_fee_minor <= amount_minor);

COMMENT ON COLUMN public.live_spark_purchases.provider_fee_minor IS
  'Verified provider deductions from the buyer-paid amount in minor currency units; used for transparent creator reward accounting.';

COMMIT;
