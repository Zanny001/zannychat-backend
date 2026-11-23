BEGIN;

ALTER TABLE public.live_spark_purchases
  ADD COLUMN IF NOT EXISTS risk_held_sparks bigint NOT NULL DEFAULT 0
  CHECK (risk_held_sparks >= 0);

CREATE TABLE IF NOT EXISTS public.live_purchase_risk_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_id uuid REFERENCES public.live_spark_purchases(id) ON DELETE SET NULL,
  provider text NOT NULL DEFAULT 'paystack' CHECK (provider = 'paystack'),
  event_key text NOT NULL UNIQUE CHECK (length(event_key) BETWEEN 8 AND 200),
  event_type text NOT NULL CHECK (event_type IN (
    'refund.pending',
    'refund.processing',
    'refund.needs-attention',
    'refund.failed',
    'refund.processed',
    'charge.dispute.create',
    'charge.dispute.remind',
    'charge.dispute.resolve'
  )),
  provider_resource_id text,
  provider_reference text NOT NULL,
  provider_status text,
  resolution text,
  amount_minor bigint CHECK (amount_minor IS NULL OR amount_minor >= 0),
  currency text,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'failed', 'unmatched')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS live_purchase_risk_events_purchase_status_idx
  ON public.live_purchase_risk_events(purchase_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS live_purchase_risk_events_reference_idx
  ON public.live_purchase_risk_events(provider_reference, created_at DESC);

ALTER TABLE public.live_purchase_risk_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.live_purchase_risk_events FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.live_purchase_risk_events TO service_role;

CREATE OR REPLACE FUNCTION public.record_live_purchase_risk_event(
  p_event_key text,
  p_event_type text,
  p_provider_resource_id text,
  p_provider_reference text,
  p_provider_status text,
  p_amount_minor bigint,
  p_currency text,
  p_resolution text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_purchase public.live_spark_purchases%ROWTYPE;
  v_event_id uuid;
  v_event_status text := 'open';
  v_remaining bigint := 0;
  v_adjust bigint := 0;
  v_open_events bigint := 0;
  v_full_refund boolean := false;
  v_restore boolean := false;
BEGIN
  IF p_event_key IS NULL OR length(p_event_key) NOT BETWEEN 8 AND 200
     OR p_provider_reference IS NULL OR length(p_provider_reference) NOT BETWEEN 3 AND 128
     OR p_event_type NOT IN (
       'refund.pending', 'refund.processing', 'refund.needs-attention',
       'refund.failed', 'refund.processed',
       'charge.dispute.create', 'charge.dispute.remind', 'charge.dispute.resolve'
     )
     OR (p_amount_minor IS NOT NULL AND p_amount_minor < 0) THEN
    RAISE EXCEPTION 'invalid LIVE purchase risk event' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('live-purchase-risk:' || p_provider_reference, 0));

  SELECT * INTO v_purchase
  FROM public.live_spark_purchases
  WHERE provider = 'paystack' AND provider_reference = p_provider_reference;

  IF NOT FOUND THEN
    INSERT INTO public.live_purchase_risk_events(
      event_key, event_type, provider_resource_id, provider_reference,
      provider_status, resolution, amount_minor, currency, status
    ) VALUES (
      p_event_key, p_event_type, p_provider_resource_id, p_provider_reference,
      p_provider_status, p_resolution, p_amount_minor, p_currency, 'unmatched'
    ) ON CONFLICT (event_key) DO NOTHING;
    RETURN jsonb_build_object('unmatched', true, 'replayed', false);
  END IF;

  -- Match the gift path's lock order: wallet first, then purchase, then lots.
  IF v_purchase.user_id IS NOT NULL THEN
    INSERT INTO public.live_gift_wallets(user_id, balance_sparks)
    VALUES (v_purchase.user_id, 0) ON CONFLICT (user_id) DO NOTHING;
    PERFORM 1 FROM public.live_gift_wallets WHERE user_id = v_purchase.user_id FOR UPDATE;
  END IF;

  SELECT * INTO v_purchase
  FROM public.live_spark_purchases
  WHERE id = v_purchase.id
  FOR UPDATE;

  IF p_currency IS NULL OR upper(p_currency) <> v_purchase.currency
     OR (p_amount_minor IS NOT NULL AND p_amount_minor > v_purchase.amount_minor) THEN
    RAISE EXCEPTION 'provider risk resource does not match the purchase amount or currency' USING ERRCODE = '22023';
  END IF;

  IF p_event_type = 'charge.dispute.resolve'
     AND p_resolution NOT IN ('merchant-accepted', 'declined') THEN
    RAISE EXCEPTION 'unsupported dispute resolution' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.live_purchase_risk_events(
    purchase_id, event_key, event_type, provider_resource_id, provider_reference,
    provider_status, resolution, amount_minor, currency, status
  ) VALUES (
    v_purchase.id, p_event_key, p_event_type, p_provider_resource_id, p_provider_reference,
    p_provider_status, p_resolution, p_amount_minor, p_currency, 'open'
  ) ON CONFLICT (event_key) DO NOTHING
  RETURNING id INTO v_event_id;

  IF v_event_id IS NULL THEN
    RETURN jsonb_build_object('replayed', true, 'purchaseId', v_purchase.id, 'status', v_purchase.status);
  END IF;

  IF v_purchase.status = 'refunded' THEN
    UPDATE public.live_purchase_risk_events SET status = 'resolved', updated_at = now()
      WHERE id = v_event_id;
    RETURN jsonb_build_object('alreadyRefunded', true, 'purchaseId', v_purchase.id, 'status', 'refunded');
  END IF;

  IF p_event_type IN (
    'refund.pending', 'refund.processing', 'refund.needs-attention',
    'charge.dispute.create', 'charge.dispute.remind'
  ) THEN
    -- Freeze unspent purchased Sparks and related creator rewards while the
    -- provider's refund/dispute outcome is unresolved.
    IF v_purchase.status = 'paid' THEN
      SELECT COALESCE(sum(remaining_sparks), 0) INTO v_remaining
      FROM public.live_spark_lots WHERE purchase_id = v_purchase.id;
      IF v_remaining > 0 AND v_purchase.user_id IS NOT NULL THEN
        UPDATE public.live_gift_wallets
          SET balance_sparks = balance_sparks - v_remaining, updated_at = now()
          WHERE user_id = v_purchase.user_id AND balance_sparks >= v_remaining;
        IF NOT FOUND THEN RAISE EXCEPTION 'wallet balance cannot cover risk hold' USING ERRCODE = 'P0001'; END IF;
      END IF;
      UPDATE public.live_spark_purchases
        SET status = 'disputed', risk_held_sparks = v_remaining, updated_at = now()
        WHERE id = v_purchase.id;
    ELSIF v_purchase.status IN ('pending', 'failed') THEN
      UPDATE public.live_spark_purchases
        SET status = 'disputed', risk_held_sparks = 0, updated_at = now()
        WHERE id = v_purchase.id;
    END IF;

    UPDATE public.live_creator_earnings_ledger e
      SET status = 'held'
      WHERE e.status IN ('pending', 'available')
        AND e.gift_transaction_id IN (
          SELECT a.gift_transaction_id
          FROM public.live_spark_spend_allocations a
          JOIN public.live_spark_lots l ON l.id = a.lot_id
          WHERE l.purchase_id = v_purchase.id
        );
    RETURN jsonb_build_object('held', true, 'purchaseId', v_purchase.id, 'status', 'disputed');
  END IF;

  IF p_event_type = 'refund.processed' OR
     (p_event_type = 'charge.dispute.resolve' AND p_resolution = 'merchant-accepted') THEN
    v_full_refund := COALESCE(p_amount_minor, 0) >= v_purchase.amount_minor;
    IF NOT v_full_refund THEN
      -- Partial refunds require operator review; conservatively keep the full
      -- purchase lot and associated creator rewards frozen.
      IF v_purchase.status = 'paid' THEN
        SELECT COALESCE(sum(remaining_sparks), 0) INTO v_remaining
        FROM public.live_spark_lots WHERE purchase_id = v_purchase.id;
        IF v_remaining > 0 AND v_purchase.user_id IS NOT NULL THEN
          UPDATE public.live_gift_wallets
            SET balance_sparks = balance_sparks - v_remaining, updated_at = now()
            WHERE user_id = v_purchase.user_id AND balance_sparks >= v_remaining;
          IF NOT FOUND THEN RAISE EXCEPTION 'wallet balance cannot cover partial-refund hold' USING ERRCODE = 'P0001'; END IF;
        END IF;
        UPDATE public.live_spark_purchases
          SET status = 'disputed', risk_held_sparks = v_remaining, updated_at = now()
          WHERE id = v_purchase.id;
      END IF;
      UPDATE public.live_creator_earnings_ledger e
        SET status = 'held'
        WHERE e.status IN ('pending', 'available')
          AND e.gift_transaction_id IN (
            SELECT a.gift_transaction_id
            FROM public.live_spark_spend_allocations a
            JOIN public.live_spark_lots l ON l.id = a.lot_id
            WHERE l.purchase_id = v_purchase.id
          );
      RETURN jsonb_build_object('manualReviewRequired', true, 'purchaseId', v_purchase.id, 'status', 'disputed');
    END IF;

    SELECT COALESCE(sum(remaining_sparks), 0) INTO v_remaining
    FROM public.live_spark_lots WHERE purchase_id = v_purchase.id;
    v_adjust := GREATEST(v_remaining - v_purchase.risk_held_sparks, 0);
    IF v_adjust > 0 AND v_purchase.user_id IS NOT NULL THEN
      UPDATE public.live_gift_wallets
        SET balance_sparks = balance_sparks - v_adjust, updated_at = now()
        WHERE user_id = v_purchase.user_id AND balance_sparks >= v_adjust;
      IF NOT FOUND THEN RAISE EXCEPTION 'wallet balance cannot cover refund revocation' USING ERRCODE = 'P0001'; END IF;
    END IF;
    UPDATE public.live_spark_lots SET remaining_sparks = 0 WHERE purchase_id = v_purchase.id;
    UPDATE public.live_spark_purchases
      SET status = 'refunded', risk_held_sparks = 0, refunded_at = now(), updated_at = now()
      WHERE id = v_purchase.id;
    UPDATE public.live_creator_earnings_ledger e
      SET status = 'held'
      WHERE e.gift_transaction_id IN (
        SELECT a.gift_transaction_id
        FROM public.live_spark_spend_allocations a
        JOIN public.live_spark_lots l ON l.id = a.lot_id
        WHERE l.purchase_id = v_purchase.id
      );
    UPDATE public.live_purchase_risk_events
      SET status = 'resolved', updated_at = now()
      WHERE purchase_id = v_purchase.id AND status = 'open';
    RETURN jsonb_build_object('refunded', true, 'purchaseId', v_purchase.id, 'status', 'refunded');
  END IF;

  IF p_event_type = 'refund.failed' OR
     (p_event_type = 'charge.dispute.resolve' AND p_resolution = 'declined') THEN
    v_event_status := CASE WHEN p_event_type = 'refund.failed' THEN 'failed' ELSE 'resolved' END;
    UPDATE public.live_purchase_risk_events
      SET status = v_event_status, updated_at = now()
      WHERE id = v_event_id;

    SELECT count(*) INTO v_open_events
    FROM public.live_purchase_risk_events
    WHERE purchase_id = v_purchase.id AND status = 'open';
    IF v_open_events = 0 AND v_purchase.status = 'disputed' THEN
      IF v_purchase.risk_held_sparks > 0 AND v_purchase.user_id IS NOT NULL THEN
        UPDATE public.live_gift_wallets
          SET balance_sparks = balance_sparks + v_purchase.risk_held_sparks, updated_at = now()
          WHERE user_id = v_purchase.user_id;
      END IF;
      UPDATE public.live_spark_purchases
        SET status = 'paid', risk_held_sparks = 0, updated_at = now()
        WHERE id = v_purchase.id;
      UPDATE public.live_creator_earnings_ledger e
        SET status = CASE WHEN e.available_at > now() THEN 'pending' ELSE 'available' END
        WHERE e.status = 'held'
          AND e.gift_transaction_id IN (
            SELECT a.gift_transaction_id
            FROM public.live_spark_spend_allocations a
            JOIN public.live_spark_lots l ON l.id = a.lot_id
            WHERE l.purchase_id = v_purchase.id
          );
    END IF;
    RETURN jsonb_build_object('restored', v_open_events = 0, 'purchaseId', v_purchase.id, 'status', CASE WHEN v_open_events = 0 THEN 'paid' ELSE 'disputed' END);
  END IF;

  RAISE EXCEPTION 'unsupported LIVE purchase risk transition' USING ERRCODE = '22023';
END;
$$;

REVOKE ALL ON FUNCTION public.record_live_purchase_risk_event(text, text, text, text, text, bigint, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_live_purchase_risk_event(text, text, text, text, text, bigint, text, text)
  TO service_role;

COMMENT ON TABLE public.live_purchase_risk_events IS
  'Idempotent, provider-verified Paystack refund and dispute event ledger. Partial refunds remain held for operator reconciliation.';

COMMIT;
