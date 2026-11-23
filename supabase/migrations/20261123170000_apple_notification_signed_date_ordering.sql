-- Apply Apple notification signedDate ordering per transaction to prevent stale refund state.
BEGIN;

CREATE TABLE IF NOT EXISTS public.live_apple_transaction_notification_state (
  transaction_key text PRIMARY KEY CHECK (transaction_key ~ '^apple:[0-9a-f]{64}$'),
  latest_signed_date bigint NOT NULL CHECK (latest_signed_date > 0),
  latest_notification_uuid text NOT NULL,
  latest_notification_type text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.live_apple_transaction_notification_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.live_apple_transaction_notification_state FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.live_apple_transaction_notification_state TO service_role;

ALTER TABLE public.live_apple_server_notifications
  ADD COLUMN IF NOT EXISTS signed_date bigint;

CREATE OR REPLACE FUNCTION public.record_live_apple_refund(
  p_event_key text,
  p_provider_transaction_id text,
  p_amount_minor bigint,
  p_currency text,
  p_refund_type text,
  p_provider_resource_id text,
  p_signed_date bigint
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_purchase public.live_spark_purchases%ROWTYPE;
  v_event_id uuid;
  v_remaining bigint := 0;
  v_adjust bigint := 0;
  v_creator_has_payouts boolean := false;
  v_event_status text := 'resolved';
  v_last_signed_date bigint;
BEGIN
  IF p_event_key IS NULL OR length(p_event_key) NOT BETWEEN 8 AND 200
     OR p_provider_transaction_id IS NULL OR length(p_provider_transaction_id) NOT BETWEEN 8 AND 128
     OR p_amount_minor IS NULL OR p_amount_minor <= 0
     OR p_currency IS NULL OR upper(p_currency) <> 'NGN'
     OR p_refund_type IS NULL OR p_refund_type NOT IN ('full', 'partial')
     OR p_provider_resource_id IS NULL OR length(p_provider_resource_id) NOT BETWEEN 3 AND 200
     OR p_signed_date IS NULL OR p_signed_date <= 0 THEN
    RAISE EXCEPTION 'invalid Apple refund event' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('live-apple-refund:' || p_provider_transaction_id, 0));
  SELECT latest_signed_date INTO v_last_signed_date
  FROM public.live_apple_transaction_notification_state
  WHERE transaction_key = p_provider_transaction_id
  FOR UPDATE;
  IF FOUND AND p_signed_date <= v_last_signed_date THEN
    RETURN jsonb_build_object('stale', true, 'replayed', false, 'lastSignedDate', v_last_signed_date);
  END IF;
  INSERT INTO public.live_apple_transaction_notification_state(
    transaction_key, latest_signed_date, latest_notification_uuid, latest_notification_type
  ) VALUES (p_provider_transaction_id, p_signed_date, p_event_key, 'REFUND')
  ON CONFLICT (transaction_key) DO UPDATE SET
    latest_signed_date = EXCLUDED.latest_signed_date,
    latest_notification_uuid = EXCLUDED.latest_notification_uuid,
    latest_notification_type = EXCLUDED.latest_notification_type,
    updated_at = now();
  SELECT * INTO v_purchase
  FROM public.live_spark_purchases
  WHERE provider = 'apple_iap' AND provider_transaction_id = p_provider_transaction_id;
  IF NOT FOUND THEN
    INSERT INTO public.live_purchase_risk_events(
      provider, event_key, event_type, provider_resource_id, provider_reference,
      provider_status, amount_minor, currency, status
    ) VALUES (
      'apple_iap', p_event_key, 'apple.refund', p_provider_resource_id,
      p_provider_transaction_id, 'refunded', p_amount_minor, 'NGN', 'unmatched'
    ) ON CONFLICT (event_key) DO NOTHING;
    RETURN jsonb_build_object('unmatched', true, 'replayed', false);
  END IF;

  IF v_purchase.amount_minor <> p_amount_minor OR v_purchase.currency <> 'NGN' THEN
    RAISE EXCEPTION 'Apple refund does not match the stored Sparks purchase amount' USING ERRCODE = '22023';
  END IF;

  IF v_purchase.user_id IS NOT NULL THEN
    INSERT INTO public.live_gift_wallets(user_id, balance_sparks)
      VALUES (v_purchase.user_id, 0) ON CONFLICT (user_id) DO NOTHING;
    PERFORM 1 FROM public.live_gift_wallets WHERE user_id = v_purchase.user_id FOR UPDATE;
  END IF;
  SELECT * INTO v_purchase FROM public.live_spark_purchases WHERE id = v_purchase.id FOR UPDATE;

  INSERT INTO public.live_purchase_risk_events(
    purchase_id, provider, event_key, event_type, provider_resource_id,
    provider_reference, provider_status, amount_minor, currency, status
  ) VALUES (
    v_purchase.id, 'apple_iap', p_event_key, 'apple.refund',
    p_provider_resource_id, v_purchase.provider_reference, 'refunded',
    p_amount_minor, 'NGN', 'open'
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

  IF v_purchase.status IN ('pending', 'failed') THEN
    UPDATE public.live_spark_purchases
      SET status = 'refunded', risk_held_sparks = 0, refunded_at = now(), updated_at = now()
      WHERE id = v_purchase.id;
    UPDATE public.live_purchase_risk_events SET status = 'resolved', updated_at = now()
      WHERE id = v_event_id;
    RETURN jsonb_build_object('revoked', true, 'uncreditedPurchase', true, 'purchaseId', v_purchase.id);
  END IF;

  IF v_purchase.status NOT IN ('paid', 'disputed') THEN
    RAISE EXCEPTION 'Apple Sparks purchase is not eligible for refund reconciliation' USING ERRCODE = '23514';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.live_creator_payouts p
    WHERE p.creator_id = v_purchase.user_id
      AND p.status IN ('requested', 'processing', 'paid')
  ) INTO v_creator_has_payouts;
  IF v_creator_has_payouts THEN
    UPDATE public.live_creator_payout_profiles
      SET payout_hold = true, updated_at = now()
      WHERE creator_id = v_purchase.user_id;
  END IF;

  SELECT COALESCE(sum(remaining_sparks), 0) INTO v_remaining
  FROM public.live_spark_lots WHERE purchase_id = v_purchase.id;

  IF p_refund_type = 'partial' THEN
    v_adjust := CASE WHEN v_purchase.status = 'disputed' THEN 0 ELSE v_remaining END;
    IF v_adjust > 0 AND v_purchase.user_id IS NOT NULL THEN
      UPDATE public.live_gift_wallets
        SET balance_sparks = balance_sparks - v_adjust, updated_at = now()
        WHERE user_id = v_purchase.user_id AND balance_sparks >= v_adjust;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'wallet balance cannot cover Apple partial-refund hold' USING ERRCODE = 'P0001';
      END IF;
    END IF;
    UPDATE public.live_spark_purchases
      SET status = 'disputed', risk_held_sparks = v_remaining, updated_at = now()
      WHERE id = v_purchase.id;
    UPDATE public.live_creator_earnings_ledger e
      SET status = 'held', risk_hold_reason = 'apple_iap_risk'
      WHERE e.status IN ('pending', 'available')
        AND e.gift_transaction_id IN (
          SELECT a.gift_transaction_id
          FROM public.live_spark_spend_allocations a
          JOIN public.live_spark_lots l ON l.id = a.lot_id
          WHERE l.purchase_id = v_purchase.id
        );
    RETURN jsonb_build_object('manualReviewRequired', true, 'purchaseId', v_purchase.id,
      'status', 'disputed', 'heldSparks', v_remaining,
      'creatorPayoutReconciliationRequired', v_creator_has_payouts);
  END IF;

  v_adjust := GREATEST(v_remaining - v_purchase.risk_held_sparks, 0);
  IF v_adjust > 0 AND v_purchase.user_id IS NOT NULL THEN
    UPDATE public.live_gift_wallets
      SET balance_sparks = balance_sparks - v_adjust, updated_at = now()
      WHERE user_id = v_purchase.user_id AND balance_sparks >= v_adjust;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'wallet balance cannot cover Apple refund revocation' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  UPDATE public.live_spark_lots SET remaining_sparks = 0 WHERE purchase_id = v_purchase.id;
  UPDATE public.live_spark_purchases
    SET status = 'refunded', risk_held_sparks = 0, refunded_at = now(), updated_at = now()
    WHERE id = v_purchase.id;
  UPDATE public.live_creator_earnings_ledger e
    SET status = 'held', risk_hold_reason = 'apple_iap_risk'
    WHERE e.status IN ('pending', 'available')
      AND e.gift_transaction_id IN (
        SELECT a.gift_transaction_id
        FROM public.live_spark_spend_allocations a
        JOIN public.live_spark_lots l ON l.id = a.lot_id
        WHERE l.purchase_id = v_purchase.id
      );

  v_event_status := CASE WHEN v_creator_has_payouts THEN 'open' ELSE 'resolved' END;
  UPDATE public.live_purchase_risk_events SET status = v_event_status, updated_at = now()
    WHERE id = v_event_id;

  RETURN jsonb_build_object('revoked', true, 'purchaseId', v_purchase.id,
    'status', 'refunded', 'revokedSparks', v_adjust,
    'manualReviewRequired', v_creator_has_payouts);
END;
$function$;


REVOKE ALL ON FUNCTION public.record_live_apple_refund(text,text,bigint,text,text,text,bigint)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_live_apple_refund(text,text,bigint,text,text,text,bigint)
  TO service_role;
DROP FUNCTION IF EXISTS public.record_live_apple_refund(text,text,bigint,text,text,text);

CREATE OR REPLACE FUNCTION public.record_live_apple_refund_reversal(
  p_event_key text,
  p_provider_transaction_id text,
  p_provider_resource_id text,
  p_signed_date bigint
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_purchase public.live_spark_purchases%ROWTYPE;
  v_event_id uuid;
  v_restore bigint := 0;
  v_balance bigint;
  v_last_signed_date bigint;
BEGIN
  IF p_event_key IS NULL OR length(p_event_key) NOT BETWEEN 8 AND 200
     OR p_provider_transaction_id IS NULL OR p_provider_transaction_id !~ '^apple:[0-9a-f]{64}$'
     OR p_provider_resource_id IS NULL OR length(p_provider_resource_id) NOT BETWEEN 3 AND 200
     OR p_signed_date IS NULL OR p_signed_date <= 0 THEN
    RAISE EXCEPTION 'invalid Apple refund reversal event' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('live-apple-refund:' || p_provider_transaction_id, 0));
  SELECT latest_signed_date INTO v_last_signed_date
  FROM public.live_apple_transaction_notification_state
  WHERE transaction_key = p_provider_transaction_id
  FOR UPDATE;
  IF FOUND AND p_signed_date <= v_last_signed_date THEN
    RETURN jsonb_build_object('stale', true, 'replayed', false, 'lastSignedDate', v_last_signed_date);
  END IF;
  INSERT INTO public.live_apple_transaction_notification_state(
    transaction_key, latest_signed_date, latest_notification_uuid, latest_notification_type
  ) VALUES (p_provider_transaction_id, p_signed_date, p_event_key, 'REFUND_REVERSED')
  ON CONFLICT (transaction_key) DO UPDATE SET
    latest_signed_date = EXCLUDED.latest_signed_date,
    latest_notification_uuid = EXCLUDED.latest_notification_uuid,
    latest_notification_type = EXCLUDED.latest_notification_type,
    updated_at = now();
  SELECT * INTO v_purchase FROM public.live_spark_purchases
    WHERE provider = 'apple_iap' AND provider_transaction_id = p_provider_transaction_id;
  IF NOT FOUND THEN
    INSERT INTO public.live_purchase_risk_events(
      provider, event_key, event_type, provider_resource_id, provider_reference,
      provider_status, amount_minor, currency, status
    ) VALUES (
      'apple_iap', p_event_key, 'apple.refund_reversed', p_provider_resource_id,
      p_provider_transaction_id, 'refund_reversed', 0, 'NGN', 'unmatched'
    ) ON CONFLICT (event_key) DO NOTHING;
    RETURN jsonb_build_object('unmatched', true, 'replayed', false);
  END IF;

  IF v_purchase.user_id IS NOT NULL THEN
    INSERT INTO public.live_gift_wallets(user_id, balance_sparks)
      VALUES (v_purchase.user_id, 0) ON CONFLICT (user_id) DO NOTHING;
    PERFORM 1 FROM public.live_gift_wallets WHERE user_id = v_purchase.user_id FOR UPDATE;
  END IF;
  SELECT * INTO v_purchase FROM public.live_spark_purchases WHERE id = v_purchase.id FOR UPDATE;

  INSERT INTO public.live_purchase_risk_events(
    purchase_id, provider, event_key, event_type, provider_resource_id,
    provider_reference, provider_status, amount_minor, currency, status
  ) VALUES (
    v_purchase.id, 'apple_iap', p_event_key, 'apple.refund_reversed',
    p_provider_resource_id, v_purchase.provider_reference, 'refund_reversed',
    0, 'NGN', 'open'
  ) ON CONFLICT (event_key) DO NOTHING
  RETURNING id INTO v_event_id;

  IF v_event_id IS NULL THEN
    RETURN jsonb_build_object('replayed', true, 'purchaseId', v_purchase.id, 'status', v_purchase.status);
  END IF;

  IF v_purchase.status = 'disputed' THEN
    v_restore := COALESCE(v_purchase.risk_held_sparks, 0);
    IF v_restore > 0 AND v_purchase.user_id IS NULL THEN
      UPDATE public.live_purchase_risk_events SET status = 'unmatched', updated_at = now() WHERE id = v_event_id;
      RETURN jsonb_build_object('restored', false, 'manualReviewRequired', true,
        'reason', 'account_unavailable', 'purchaseId', v_purchase.id);
    END IF;
    IF v_restore > 0 THEN
      UPDATE public.live_gift_wallets
        SET balance_sparks = balance_sparks + v_restore, updated_at = now()
        WHERE user_id = v_purchase.user_id RETURNING balance_sparks INTO v_balance;
    END IF;
    UPDATE public.live_spark_purchases
      SET status = 'paid', risk_held_sparks = 0, updated_at = now()
      WHERE id = v_purchase.id;
  ELSIF v_purchase.status = 'refunded' THEN
    v_restore := COALESCE(v_purchase.refunded_unspent_sparks, 0);
    IF v_restore > 0 AND v_purchase.user_id IS NULL THEN
      UPDATE public.live_purchase_risk_events SET status = 'unmatched', updated_at = now() WHERE id = v_event_id;
      RETURN jsonb_build_object('restored', false, 'manualReviewRequired', true,
        'reason', 'account_unavailable', 'purchaseId', v_purchase.id);
    END IF;
    IF v_restore > 0 THEN
      UPDATE public.live_gift_wallets
        SET balance_sparks = balance_sparks + v_restore, updated_at = now()
        WHERE user_id = v_purchase.user_id RETURNING balance_sparks INTO v_balance;
      UPDATE public.live_spark_lots
        SET remaining_sparks = v_restore
        WHERE purchase_id = v_purchase.id;
    END IF;
    IF v_purchase.verified_at IS NULL THEN
      UPDATE public.live_spark_purchases
        SET status = 'pending', refunded_unspent_sparks = 0, refunded_at = NULL, updated_at = now()
        WHERE id = v_purchase.id;
      UPDATE public.live_purchase_risk_events SET status = 'resolved', updated_at = now()
        WHERE id = v_event_id;
      RETURN jsonb_build_object('restored', false, 'awaitingPurchaseVerification', true,
        'purchaseId', v_purchase.id, 'status', 'pending');
    END IF;
    UPDATE public.live_spark_purchases
      SET status = 'paid', refunded_unspent_sparks = 0, refunded_at = NULL, updated_at = now()
      WHERE id = v_purchase.id;
  ELSIF v_purchase.status = 'paid' THEN
    UPDATE public.live_purchase_risk_events SET status = 'resolved', updated_at = now()
      WHERE id = v_event_id;
    RETURN jsonb_build_object('alreadyRestored', true, 'purchaseId', v_purchase.id, 'status', 'paid');
  ELSE
    UPDATE public.live_purchase_risk_events SET status = 'resolved', updated_at = now()
      WHERE id = v_event_id;
    RETURN jsonb_build_object('restored', false, 'uncreditedPurchase', true,
      'purchaseId', v_purchase.id, 'status', v_purchase.status);
  END IF;

  UPDATE public.live_creator_earnings_ledger e
    SET status = CASE WHEN e.available_at <= now() THEN 'available' ELSE 'pending' END,
        risk_hold_reason = NULL
    WHERE e.risk_hold_reason = 'apple_iap_risk'
      AND e.gift_transaction_id IN (
        SELECT a.gift_transaction_id
        FROM public.live_spark_spend_allocations a
        JOIN public.live_spark_lots l ON l.id = a.lot_id
        WHERE l.purchase_id = v_purchase.id
      );

  UPDATE public.live_purchase_risk_events SET status = 'resolved', updated_at = now()
    WHERE id = v_event_id;

  RETURN jsonb_build_object('restored', true, 'purchaseId', v_purchase.id,
    'restoredSparks', v_restore, 'balanceSparks', v_balance,
    'status', 'paid', 'creatorEarningsReleasedFromRiskHold', true);
END;
$function$;


REVOKE ALL ON FUNCTION public.record_live_apple_refund_reversal(text,text,text,bigint)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_live_apple_refund_reversal(text,text,text,bigint)
  TO service_role;
DROP FUNCTION IF EXISTS public.record_live_apple_refund_reversal(text,text,text);

COMMIT;
