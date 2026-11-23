BEGIN;

ALTER TABLE public.live_spark_lots
  ADD COLUMN IF NOT EXISTS frozen_sparks bigint NOT NULL DEFAULT 0
  CHECK (frozen_sparks >= 0 AND remaining_sparks + frozen_sparks <= granted_sparks);

CREATE TABLE IF NOT EXISTS public.live_payment_risk_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_id uuid REFERENCES public.live_spark_purchases(id) ON DELETE RESTRICT,
  provider text NOT NULL CHECK (provider = 'paystack'),
  provider_event_hash text NOT NULL UNIQUE,
  provider_reference text NOT NULL,
  event_type text NOT NULL CHECK (event_type IN (
    'refund.pending','refund.processing','refund.processed','refund.failed','refund.needs-attention',
    'charge.dispute.create','charge.dispute.remind','charge.dispute.resolve'
  )),
  amount_minor bigint NOT NULL DEFAULT 0 CHECK (amount_minor >= 0),
  currency text NOT NULL DEFAULT 'NGN' CHECK (currency = 'NGN'),
  status text NOT NULL DEFAULT 'quarantined' CHECK (status IN ('quarantined','unmatched')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS live_payment_risk_events_purchase_created_idx
  ON public.live_payment_risk_events(purchase_id, created_at DESC);
CREATE INDEX IF NOT EXISTS live_spark_lots_purchase_frozen_idx
  ON public.live_spark_lots(purchase_id) WHERE frozen_sparks > 0;

ALTER TABLE public.live_payment_risk_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.live_payment_risk_events FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.live_payment_risk_events TO service_role;

CREATE OR REPLACE FUNCTION public.quarantine_live_spark_purchase(
  p_provider_reference text,
  p_event_hash text,
  p_event_type text,
  p_amount_minor bigint,
  p_currency text DEFAULT 'NGN'
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_purchase public.live_spark_purchases%ROWTYPE;
  v_lot record;
  v_frozen bigint := 0;
  v_balance bigint;
  v_held integer := 0;
BEGIN
  IF p_provider_reference IS NULL OR length(p_provider_reference) NOT BETWEEN 8 AND 128
     OR p_event_hash IS NULL OR p_event_hash !~ '^[0-9a-f]{64}$'
     OR p_event_type IS NULL OR p_event_type NOT IN (
       'refund.pending','refund.processing','refund.processed','refund.failed','refund.needs-attention',
       'charge.dispute.create','charge.dispute.remind','charge.dispute.resolve'
     )
     OR p_amount_minor IS NULL OR p_amount_minor < 0 OR p_currency IS DISTINCT FROM 'NGN' THEN
    RAISE EXCEPTION 'invalid LIVE purchase risk event' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('live-purchase-risk:' || p_provider_reference, 0));
  SELECT * INTO v_purchase FROM public.live_spark_purchases
    WHERE provider = 'paystack' AND provider_reference = p_provider_reference FOR UPDATE;

  INSERT INTO public.live_payment_risk_events
    (purchase_id, provider, provider_event_hash, provider_reference, event_type, amount_minor, currency, status)
  VALUES (v_purchase.id, 'paystack', p_event_hash, p_provider_reference, p_event_type, p_amount_minor, p_currency,
    CASE WHEN v_purchase.id IS NULL THEN 'unmatched' ELSE 'quarantined' END)
  ON CONFLICT (provider_event_hash) DO NOTHING;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ignored', true, 'reason', 'unmatched_purchase', 'replayed', false);
  END IF;

  IF v_purchase.id IS NULL THEN
    RETURN jsonb_build_object('ignored', true, 'reason', 'unmatched_purchase', 'replayed', false);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.live_payment_risk_events WHERE provider_event_hash = p_event_hash) THEN
    RETURN jsonb_build_object('ignored', true, 'reason', 'duplicate_event', 'replayed', true);
  END IF;

  IF v_purchase.status NOT IN ('paid','disputed','partially_refunded','refunded') THEN
    RETURN jsonb_build_object('ignored', true, 'reason', 'purchase_not_fulfilled', 'replayed', false);
  END IF;

  FOR v_lot IN
    SELECT id, user_id, remaining_sparks
    FROM public.live_spark_lots
    WHERE purchase_id = v_purchase.id AND remaining_sparks > 0
    ORDER BY created_at, id
    FOR UPDATE
  LOOP
    v_frozen := v_frozen + v_lot.remaining_sparks;
    UPDATE public.live_spark_lots
      SET frozen_sparks = frozen_sparks + remaining_sparks,
          remaining_sparks = 0
      WHERE id = v_lot.id;
  END LOOP;

  IF v_frozen > 0 THEN
    UPDATE public.live_gift_wallets
      SET balance_sparks = balance_sparks - v_frozen, updated_at = now()
      WHERE user_id = v_purchase.user_id AND balance_sparks >= v_frozen
      RETURNING balance_sparks INTO v_balance;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'LIVE Sparks wallet does not reconcile with refundable lots' USING ERRCODE = 'P0001';
    END IF;
    INSERT INTO public.live_gift_ledger
      (user_id, entry_type, amount_sparks, balance_after, reference_type, reference_id, idempotency_key, note)
    VALUES (v_purchase.user_id, 'spend', v_frozen, v_balance, 'purchase', v_purchase.id,
      'risk-freeze:' || p_event_hash, 'Purchased Sparks frozen pending payment risk review');
  END IF;

  UPDATE public.live_spark_purchases SET status = 'disputed', updated_at = now()
    WHERE id = v_purchase.id;

  UPDATE public.live_creator_earnings_ledger
    SET status = 'held'
    WHERE entry_type = 'earning' AND status IN ('pending','available')
      AND gift_transaction_id IN (
        SELECT a.gift_transaction_id
        FROM public.live_spark_spend_allocations a
        JOIN public.live_spark_lots l ON l.id = a.lot_id
        WHERE l.purchase_id = v_purchase.id
      );
  GET DIAGNOSTICS v_held = ROW_COUNT;

  UPDATE public.live_creator_payout_profiles p
    SET payout_hold = true, updated_at = now()
    WHERE p.creator_id IN (
      SELECT DISTINCT e.creator_id
      FROM public.live_creator_earnings_ledger e
      WHERE e.gift_transaction_id IN (
        SELECT a.gift_transaction_id
        FROM public.live_spark_spend_allocations a
        JOIN public.live_spark_lots l ON l.id = a.lot_id
        WHERE l.purchase_id = v_purchase.id
      )
    );

  RETURN jsonb_build_object(
    'purchaseId', v_purchase.id,
    'status', 'disputed',
    'frozenSparks', v_frozen,
    'heldEarningsEntries', v_held,
    'manualReviewRequired', true,
    'replayed', false
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.quarantine_live_spark_purchase(text,text,text,bigint,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.quarantine_live_spark_purchase(text,text,text,bigint,text) TO service_role;

COMMIT;
