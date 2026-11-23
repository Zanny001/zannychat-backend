-- Apple StoreKit 2 Sparks verification: stable account binding and provider-safe fulfilment.
BEGIN;

CREATE TABLE IF NOT EXISTS public.live_apple_account_bindings (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  app_account_token uuid NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.live_apple_account_bindings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.live_apple_account_bindings FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.live_apple_account_bindings TO service_role;

ALTER TABLE public.live_spark_purchases
  ADD COLUMN IF NOT EXISTS provider_product_id text,
  ADD COLUMN IF NOT EXISTS provider_environment text,
  ADD COLUMN IF NOT EXISTS provider_storefront text,
  ADD COLUMN IF NOT EXISTS provider_transaction_date timestamptz;

COMMENT ON TABLE public.live_apple_account_bindings IS
  'Service-role-only stable UUID bindings for Apple appAccountToken; never expose another account binding.';
COMMENT ON COLUMN public.live_spark_purchases.provider_environment IS
  'Verified Apple transaction environment (Production or Sandbox); sandbox purchases are never fulfilled in production.';
COMMENT ON COLUMN public.live_spark_purchases.provider_storefront IS
  'Apple-signed storefront code associated with the verified StoreKit transaction.';

CREATE OR REPLACE FUNCTION public.fulfill_live_spark_purchase(
  p_provider_reference text,
  p_provider_transaction_id text,
  p_amount_minor bigint,
  p_currency text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_purchase public.live_spark_purchases%ROWTYPE;
  v_balance bigint;
BEGIN
  IF p_provider_reference IS NULL OR length(p_provider_reference) NOT BETWEEN 8 AND 128
     OR p_provider_transaction_id IS NULL OR length(p_provider_transaction_id) NOT BETWEEN 1 AND 128
     OR p_amount_minor IS NULL OR p_amount_minor <= 0
     OR p_currency IS NULL OR p_currency NOT IN ('NGN', 'USD', 'GBP', 'EUR') THEN
    RAISE EXCEPTION 'invalid verified payment details' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('live-spark-purchase:' || p_provider_reference, 0));
  SELECT * INTO v_purchase FROM public.live_spark_purchases
    WHERE provider_reference = p_provider_reference FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'purchase order not found' USING ERRCODE = 'P0002'; END IF;

  IF v_purchase.provider NOT IN ('paystack', 'google_play', 'apple_iap') THEN
    RAISE EXCEPTION 'payment provider does not match this fulfilment handler' USING ERRCODE = '22023';
  END IF;
  IF v_purchase.user_id IS NULL THEN
    UPDATE public.live_spark_purchases
      SET status = 'disputed', updated_at = now()
      WHERE id = v_purchase.id;
    RETURN jsonb_build_object('purchaseId', v_purchase.id, 'rejected', true,
      'reason', 'account_unavailable', 'replayed', false);
  END IF;

  IF v_purchase.status = 'paid' THEN
    IF v_purchase.provider_transaction_id IS DISTINCT FROM p_provider_transaction_id
       OR v_purchase.amount_minor <> p_amount_minor OR v_purchase.currency <> p_currency THEN
      RAISE EXCEPTION 'verified payment conflicts with fulfilled purchase' USING ERRCODE = '23505';
    END IF;
    SELECT balance_sparks INTO v_balance FROM public.live_gift_wallets WHERE user_id = v_purchase.user_id;
    RETURN jsonb_build_object('purchaseId', v_purchase.id, 'sparks', v_purchase.sparks,
      'balanceSparks', COALESCE(v_balance, 0), 'replayed', true);
  END IF;

  IF v_purchase.status <> 'pending'
     OR v_purchase.amount_minor <> p_amount_minor
     OR v_purchase.currency <> p_currency
     OR v_purchase.provider_transaction_id IS NOT NULL THEN
    RAISE EXCEPTION 'payment does not match an eligible pending purchase' USING ERRCODE = '23514';
  END IF;

  UPDATE public.live_spark_purchases
    SET status = 'paid', provider_transaction_id = p_provider_transaction_id,
        verified_at = now(), updated_at = now()
    WHERE id = v_purchase.id;

  INSERT INTO public.live_gift_wallets(user_id, balance_sparks)
    VALUES (v_purchase.user_id, 0) ON CONFLICT (user_id) DO NOTHING;
  UPDATE public.live_gift_wallets
    SET balance_sparks = balance_sparks + v_purchase.sparks, updated_at = now()
    WHERE user_id = v_purchase.user_id RETURNING balance_sparks INTO v_balance;

  INSERT INTO public.live_spark_lots(user_id, purchase_id, source, granted_sparks, remaining_sparks)
    VALUES (v_purchase.user_id, v_purchase.id, 'purchase', v_purchase.sparks, v_purchase.sparks);

  INSERT INTO public.live_gift_ledger
    (user_id, entry_type, amount_sparks, balance_after, reference_type,
     reference_id, idempotency_key, note)
  VALUES (v_purchase.user_id, 'grant', v_purchase.sparks, v_balance, 'purchase',
    v_purchase.id, 'purchase:' || v_purchase.id::text, 'Verified Sparks purchase');

  RETURN jsonb_build_object('purchaseId', v_purchase.id, 'sparks', v_purchase.sparks,
    'balanceSparks', v_balance, 'replayed', false);
END;
$function$;

REVOKE ALL ON FUNCTION public.fulfill_live_spark_purchase(text, text, bigint, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fulfill_live_spark_purchase(text, text, bigint, text)
  TO service_role;

COMMENT ON FUNCTION public.fulfill_live_spark_purchase(text, text, bigint, text) IS
  'Service-role-only idempotent fulfilment for independently verified Paystack, Google Play, and Apple App Store Sparks purchases. Provider transaction identifiers must be unique per provider.';

COMMIT;
