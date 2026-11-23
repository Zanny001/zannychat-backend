-- LIVE real-money foundation: paid Sparks purchases, creator earnings and payouts.
-- All writes are server-owned. Payment fulfilment is callable only by service_role.
BEGIN;

CREATE TABLE IF NOT EXISTS public.live_spark_purchases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  provider text NOT NULL CHECK (provider IN ('paystack', 'google_play', 'apple_iap')),
  provider_reference text NOT NULL UNIQUE,
  provider_transaction_id text,
  package_id text NOT NULL,
  sparks bigint NOT NULL CHECK (sparks > 0 AND sparks <= 10000000),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0 AND amount_minor <= 9007199254740991),
  currency text NOT NULL CHECK (currency IN ('NGN', 'USD', 'GBP', 'EUR')),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'paid', 'failed', 'refunded', 'disputed')),
  verified_at timestamptz,
  refunded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'paid' AND verified_at IS NOT NULL) OR status <> 'paid')
);
CREATE UNIQUE INDEX IF NOT EXISTS live_spark_purchases_provider_transaction_idx
  ON public.live_spark_purchases(provider, provider_transaction_id) WHERE provider_transaction_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS live_spark_purchases_user_created_idx
  ON public.live_spark_purchases(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS live_spark_purchases_status_created_idx
  ON public.live_spark_purchases(status, created_at);

CREATE TABLE IF NOT EXISTS public.live_spark_packages (
  package_id text NOT NULL,
  provider text NOT NULL CHECK (provider IN ('paystack', 'google_play', 'apple_iap')),
  sparks bigint NOT NULL CHECK (sparks > 0 AND sparks <= 10000000),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0 AND amount_minor <= 9007199254740991),
  currency text NOT NULL CHECK (currency IN ('NGN', 'USD', 'GBP', 'EUR')),
  is_active boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, package_id, currency)
);
CREATE INDEX IF NOT EXISTS live_spark_packages_active_idx
  ON public.live_spark_packages(provider, currency, sort_order) WHERE is_active = true;

CREATE TABLE IF NOT EXISTS public.live_spark_lots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  purchase_id uuid REFERENCES public.live_spark_purchases(id) ON DELETE RESTRICT,
  source text NOT NULL CHECK (source IN ('purchase', 'promotion', 'support_adjustment')),
  granted_sparks bigint NOT NULL CHECK (granted_sparks > 0),
  remaining_sparks bigint NOT NULL CHECK (remaining_sparks >= 0 AND remaining_sparks <= granted_sparks),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS live_spark_lots_user_fifo_idx
  ON public.live_spark_lots(user_id, created_at, id) WHERE remaining_sparks > 0;
CREATE UNIQUE INDEX IF NOT EXISTS live_spark_lots_purchase_unique_idx
  ON public.live_spark_lots(purchase_id) WHERE purchase_id IS NOT NULL;

ALTER TABLE public.live_gift_ledger
  DROP CONSTRAINT IF EXISTS live_gift_ledger_reference_type_check;
ALTER TABLE public.live_gift_ledger
  ADD CONSTRAINT live_gift_ledger_reference_type_check
  CHECK (reference_type IN ('promotion', 'gift', 'support_adjustment', 'purchase'));

CREATE TABLE IF NOT EXISTS public.live_creator_earnings_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  stream_id uuid REFERENCES public.live_streams(id) ON DELETE SET NULL,
  gift_transaction_id uuid REFERENCES public.live_gift_transactions(id) ON DELETE SET NULL,
  entry_type text NOT NULL CHECK (entry_type IN ('earning', 'reversal', 'adjustment')),
  gross_minor bigint NOT NULL CHECK (gross_minor >= 0),
  platform_fee_minor bigint NOT NULL CHECK (platform_fee_minor >= 0),
  net_minor bigint NOT NULL CHECK (net_minor >= 0),
  currency text NOT NULL CHECK (currency = 'NGN'),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'available', 'held', 'reversed')),
  available_at timestamptz,
  idempotency_key text NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  reference_id uuid,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (platform_fee_minor <= gross_minor),
  CHECK (net_minor = gross_minor - platform_fee_minor),
  CHECK (entry_type <> 'earning' OR gift_transaction_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS live_creator_earnings_creator_status_idx
  ON public.live_creator_earnings_ledger(creator_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS live_creator_earnings_stream_idx
  ON public.live_creator_earnings_ledger(stream_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.live_payout_beneficiaries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('paystack')),
  provider_recipient_code text NOT NULL,
  bank_code text NOT NULL,
  bank_name text NOT NULL,
  account_name text NOT NULL,
  account_last4 text NOT NULL CHECK (account_last4 ~ '^[0-9]{4}$'),
  currency text NOT NULL DEFAULT 'NGN' CHECK (currency = 'NGN'),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'verified', 'disabled')),
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (creator_id, provider_recipient_code)
);
CREATE INDEX IF NOT EXISTS live_payout_beneficiaries_creator_idx
  ON public.live_payout_beneficiaries(creator_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.live_creator_payouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  beneficiary_id uuid REFERENCES public.live_payout_beneficiaries(id) ON DELETE SET NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency text NOT NULL DEFAULT 'NGN' CHECK (currency = 'NGN'),
  status text NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested', 'processing', 'paid', 'failed', 'reversed', 'cancelled')),
  provider text NOT NULL DEFAULT 'paystack' CHECK (provider IN ('paystack')),
  provider_transfer_code text UNIQUE,
  provider_reference text NOT NULL UNIQUE,
  failure_code text,
  failure_message text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS live_creator_payouts_creator_idx
  ON public.live_creator_payouts(creator_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS live_creator_payouts_status_idx
  ON public.live_creator_payouts(status, requested_at);

ALTER TABLE public.live_spark_packages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.live_spark_purchases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.live_spark_lots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.live_creator_earnings_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.live_payout_beneficiaries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.live_creator_payouts ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.live_spark_packages, public.live_spark_purchases, public.live_spark_lots,
  public.live_creator_earnings_ledger, public.live_payout_beneficiaries,
  public.live_creator_payouts FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.live_spark_packages, public.live_spark_purchases, public.live_spark_lots,
  public.live_creator_earnings_ledger, public.live_payout_beneficiaries,
  public.live_creator_payouts TO service_role;

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

COMMENT ON TABLE public.live_spark_packages IS
  'Operator-configured, provider-specific Sparks packages. No package is purchasable until explicitly activated.';
COMMENT ON TABLE public.live_spark_purchases IS
  'Server-created payment orders; only verified provider callbacks may fulfil them.';
COMMENT ON TABLE public.live_spark_lots IS
  'Separate purchased and promotional Sparks lots for source-aware consumption and reversals.';
COMMENT ON TABLE public.live_creator_earnings_ledger IS
  'NGN creator earnings, separate from LIVE gift points and Sparks.';
COMMENT ON TABLE public.live_payout_beneficiaries IS
  'Stores provider recipient tokens and masked bank details only; never raw account numbers or BVN.';
COMMENT ON TABLE public.live_creator_payouts IS
  'Auditable creator payout requests and provider transfer reconciliation.';

COMMIT;
