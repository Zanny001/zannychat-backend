-- Withhold Apple-funded creator rewards until actual App Store proceeds are reconciled.
BEGIN;

ALTER TABLE public.live_spark_purchases
  ADD COLUMN IF NOT EXISTS provider_fee_status text NOT NULL DEFAULT 'verified'
  CHECK (provider_fee_status IN ('verified', 'pending'));

ALTER TABLE public.live_gift_transactions
  ADD COLUMN IF NOT EXISTS reward_rule_id uuid
  REFERENCES public.live_creator_reward_rules(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS live_spark_purchases_provider_fee_pending_idx
  ON public.live_spark_purchases(provider, provider_fee_status, created_at)
  WHERE provider = 'apple_iap' AND provider_fee_status = 'pending';

CREATE OR REPLACE FUNCTION public.send_live_gift(
  p_sender_id uuid, p_stream_id uuid, p_recipient_id uuid, p_gift_id text,
  p_quantity integer, p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_stream public.live_streams%ROWTYPE;
  v_gift public.live_gift_catalog%ROWTYPE;
  v_existing public.live_gift_transactions%ROWTYPE;
  v_balance bigint;
  v_total bigint;
  v_points bigint;
  v_transaction_id uuid;
  v_battle public.live_pk_battles%ROWTYPE;
  v_effective_battle_id uuid;
  v_lot record;
  v_alloc record;
  v_purchase record;
  v_rule public.live_creator_reward_rules%ROWTYPE;
  v_remaining bigint;
  v_take bigint;
  v_purchased_spent bigint := 0;
  v_promotional_spent bigint := 0;
  v_legacy_spent bigint := 0;
  v_allocations jsonb := '[]'::jsonb;
  v_purchase_value bigint;
  v_eligible_gross bigint := 0;
  v_creator_net bigint;
  v_platform_fee bigint;
  v_pending_provider_fee boolean := false;
BEGIN
  IF p_sender_id IS NULL OR p_stream_id IS NULL OR p_recipient_id IS NULL
     OR p_sender_id = p_recipient_id OR p_quantity IS NULL OR p_quantity NOT BETWEEN 1 AND 20
     OR p_idempotency_key IS NULL OR length(p_idempotency_key) NOT BETWEEN 8 AND 128 THEN
    RAISE EXCEPTION 'invalid LIVE gift request' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_sender_id::text || ':' || p_idempotency_key, 0));
  SELECT * INTO v_existing FROM public.live_gift_transactions
    WHERE sender_id = p_sender_id AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.stream_id <> p_stream_id OR v_existing.recipient_id <> p_recipient_id
       OR v_existing.gift_id <> p_gift_id OR v_existing.quantity <> p_quantity THEN
      RAISE EXCEPTION 'idempotency key reused with different gift details' USING ERRCODE = '23505';
    END IF;
    SELECT balance_sparks INTO v_balance FROM public.live_gift_wallets WHERE user_id = p_sender_id;
    RETURN jsonb_build_object('transactionId', v_existing.id, 'balanceSparks', COALESCE(v_balance, 0),
      'scorePoints', v_existing.score_points, 'replayed', true);
  END IF;

  SELECT * INTO v_stream FROM public.live_streams WHERE id = p_stream_id FOR UPDATE;
  IF NOT FOUND OR v_stream.status <> 'live' THEN
    RAISE EXCEPTION 'LIVE stream is not active' USING ERRCODE = 'P0001';
  END IF;
  PERFORM 1 FROM public.live_stream_participants
    WHERE stream_id = p_stream_id AND user_id = p_sender_id AND status = 'joined' AND left_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'sender must be a joined LIVE participant' USING ERRCODE = '42501'; END IF;
  PERFORM 1 FROM public.live_stream_participants
    WHERE stream_id = p_stream_id AND user_id = p_recipient_id
      AND role IN ('creator', 'guest') AND status = 'joined' AND left_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'recipient is not an active LIVE stage participant' USING ERRCODE = '22023'; END IF;

  SELECT * INTO v_gift FROM public.live_gift_catalog WHERE gift_id = p_gift_id AND is_active = true;
  IF NOT FOUND THEN RAISE EXCEPTION 'LIVE gift is unavailable' USING ERRCODE = '22023'; END IF;
  v_total := v_gift.spark_cost::bigint * p_quantity;
  v_points := v_gift.score_points::bigint * p_quantity;

  SELECT * INTO v_battle FROM public.live_pk_battles
    WHERE stream_id = p_stream_id AND status = 'live'
      AND now() >= started_at AND now() < ends_at
      AND p_recipient_id IN (creator_a_id, creator_b_id) FOR UPDATE;
  IF FOUND THEN v_effective_battle_id := v_battle.id;
  ELSE v_effective_battle_id := NULL;
  END IF;

  INSERT INTO public.live_gift_wallets(user_id, balance_sparks)
    VALUES (p_sender_id, 0) ON CONFLICT (user_id) DO NOTHING;
  SELECT balance_sparks INTO v_balance FROM public.live_gift_wallets
    WHERE user_id = p_sender_id FOR UPDATE;
  IF v_balance < v_total THEN RAISE EXCEPTION 'insufficient LIVE Sparks' USING ERRCODE = 'P0001'; END IF;

  v_remaining := v_total;
  FOR v_lot IN
    SELECT id, source, remaining_sparks FROM public.live_spark_lots
    WHERE user_id = p_sender_id AND remaining_sparks > 0
    ORDER BY CASE source WHEN 'promotion' THEN 0 WHEN 'support_adjustment' THEN 1
      WHEN 'legacy' THEN 2 ELSE 3 END, created_at, id FOR UPDATE
  LOOP
    EXIT WHEN v_remaining = 0;
    v_take := LEAST(v_remaining, v_lot.remaining_sparks);
    UPDATE public.live_spark_lots SET remaining_sparks = remaining_sparks - v_take WHERE id = v_lot.id;
    IF v_lot.source = 'purchase' THEN
      v_purchased_spent := v_purchased_spent + v_take;
      v_allocations := v_allocations || jsonb_build_array(jsonb_build_object('lot_id', v_lot.id, 'sparks', v_take));
    ELSIF v_lot.source IN ('promotion', 'support_adjustment') THEN
      v_promotional_spent := v_promotional_spent + v_take;
    ELSE
      v_legacy_spent := v_legacy_spent + v_take;
    END IF;
    v_remaining := v_remaining - v_take;
  END LOOP;
  IF v_remaining > 0 THEN
    RAISE EXCEPTION 'LIVE Sparks source ledger is inconsistent' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.live_gift_wallets SET balance_sparks = balance_sparks - v_total, updated_at = now()
    WHERE user_id = p_sender_id RETURNING balance_sparks INTO v_balance;

  INSERT INTO public.live_gift_transactions
    (sender_id, recipient_id, stream_id, gift_id, quantity, total_sparks, score_points, battle_id,
     purchased_sparks_spent, promotional_sparks_spent, legacy_sparks_spent, idempotency_key)
  VALUES
    (p_sender_id, p_recipient_id, p_stream_id, p_gift_id, p_quantity, v_total, v_points, v_effective_battle_id,
     v_purchased_spent, v_promotional_spent, v_legacy_spent, p_idempotency_key)
  RETURNING id INTO v_transaction_id;

  FOR v_alloc IN
    SELECT lot_id, sparks FROM jsonb_to_recordset(v_allocations) AS x(lot_id uuid, sparks bigint)
  LOOP
    SELECT p.amount_minor, p.provider_fee_minor, p.provider_fee_status, p.sparks INTO v_purchase
    FROM public.live_spark_lots l
    JOIN public.live_spark_purchases p ON p.id = l.purchase_id
    WHERE l.id = v_alloc.lot_id AND p.status = 'paid'
    FOR SHARE OF p;
    IF NOT FOUND THEN RAISE EXCEPTION 'purchased Sparks lot has no verified purchase' USING ERRCODE = 'P0001'; END IF;
    IF v_purchase.provider_fee_status = 'verified' THEN
      v_purchase_value := FLOOR((v_purchase.amount_minor - v_purchase.provider_fee_minor)::numeric * v_alloc.sparks / v_purchase.sparks)::bigint;
    ELSE
      v_purchase_value := 0;
      v_pending_provider_fee := true;
    END IF;
    INSERT INTO public.live_spark_spend_allocations
      (gift_transaction_id, lot_id, sparks_spent, purchase_value_minor)
    VALUES (v_transaction_id, v_alloc.lot_id, v_alloc.sparks, v_purchase_value);
    v_eligible_gross := v_eligible_gross + v_purchase_value;
  END LOOP;

  INSERT INTO public.live_gift_ledger
    (user_id, entry_type, amount_sparks, balance_after, reference_type, reference_id, idempotency_key)
  VALUES (p_sender_id, 'spend', v_total, v_balance, 'gift', v_transaction_id, 'gift:' || v_transaction_id::text);

  SELECT * INTO v_rule FROM public.live_creator_reward_rules
    WHERE is_active = true ORDER BY created_at DESC LIMIT 1 FOR SHARE;
  IF FOUND THEN
    UPDATE public.live_gift_transactions SET reward_rule_id = v_rule.id WHERE id = v_transaction_id;
  END IF;
  IF FOUND AND v_eligible_gross > 0 AND NOT v_pending_provider_fee THEN
    v_creator_net := FLOOR(v_eligible_gross::numeric * v_rule.creator_share_bps / 10000)::bigint;
    v_platform_fee := v_eligible_gross - v_creator_net;
    IF v_creator_net > 0 THEN
      INSERT INTO public.live_creator_earnings_ledger
        (creator_id, stream_id, gift_transaction_id, reward_rule_id, entry_type,
         gross_minor, platform_fee_minor, net_minor, currency, status, available_at,
         idempotency_key, reference_id, note)
      VALUES
        (p_recipient_id, p_stream_id, v_transaction_id, v_rule.id, 'earning',
         v_eligible_gross, v_platform_fee, v_creator_net, 'NGN', 'pending',
         now() + make_interval(hours => v_rule.clearance_hours),
         'live-earn:' || v_transaction_id::text, v_transaction_id,
         'Creator share from verified purchased Sparks gifts');
    END IF;
  END IF;

  IF v_effective_battle_id IS NOT NULL THEN
    IF p_recipient_id = v_battle.creator_a_id THEN
      UPDATE public.live_pk_battles SET score_a = score_a + v_points, updated_at = now()
        WHERE id = v_effective_battle_id;
    ELSE
      UPDATE public.live_pk_battles SET score_b = score_b + v_points, updated_at = now()
        WHERE id = v_effective_battle_id;
    END IF;
  END IF;

  RETURN jsonb_build_object('transactionId', v_transaction_id, 'balanceSparks', v_balance,
    'scorePoints', v_points, 'purchasedSparksSpent', v_purchased_spent,
    'promotionalSparksSpent', v_promotional_spent, 'legacySparksSpent', v_legacy_spent,
    'creatorEarningCreated', v_eligible_gross > 0 AND v_rule.id IS NOT NULL AND NOT v_pending_provider_fee,
    'providerFeePending', v_pending_provider_fee, 'replayed', false);
END;
$function$;

CREATE OR REPLACE FUNCTION public.reconcile_live_apple_provider_fee(
  p_provider_transaction_id text,
  p_provider_fee_minor bigint
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_purchase public.live_spark_purchases%ROWTYPE;
  v_gift record;
  v_rule public.live_creator_reward_rules%ROWTYPE;
  v_gross bigint;
  v_creator_net bigint;
  v_platform_fee bigint;
  v_created integer := 0;
BEGIN
  IF p_provider_transaction_id IS NULL
     OR p_provider_transaction_id !~ '^apple:[0-9a-f]{64}$'
     OR p_provider_fee_minor IS NULL OR p_provider_fee_minor < 0 THEN
    RAISE EXCEPTION 'invalid Apple provider fee reconciliation details' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('live-apple-provider-fee:' || p_provider_transaction_id, 0));
  SELECT * INTO v_purchase
  FROM public.live_spark_purchases
  WHERE provider = 'apple_iap' AND provider_transaction_id = p_provider_transaction_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Apple Sparks purchase was not found' USING ERRCODE = 'P0002'; END IF;
  IF v_purchase.status <> 'paid' THEN
    RAISE EXCEPTION 'only a paid Apple purchase can have its provider fee reconciled' USING ERRCODE = '23514';
  END IF;
  IF p_provider_fee_minor >= v_purchase.amount_minor THEN
    RAISE EXCEPTION 'Apple provider fee must be lower than the verified buyer-paid amount' USING ERRCODE = '22023';
  END IF;

  IF v_purchase.provider_fee_status = 'verified' THEN
    IF v_purchase.provider_fee_minor <> p_provider_fee_minor THEN
      RAISE EXCEPTION 'Apple provider fee was already reconciled with a different amount' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object('replayed', true, 'purchaseId', v_purchase.id, 'earningsCreated', 0);
  END IF;

  UPDATE public.live_spark_purchases
  SET provider_fee_minor = p_provider_fee_minor,
      provider_fee_status = 'verified',
      updated_at = now()
  WHERE id = v_purchase.id;

  UPDATE public.live_spark_spend_allocations a
  SET purchase_value_minor = FLOOR(
    (v_purchase.amount_minor - p_provider_fee_minor)::numeric * a.sparks_spent / v_purchase.sparks
  )::bigint
  FROM public.live_spark_lots l
  WHERE a.lot_id = l.id AND l.purchase_id = v_purchase.id;

  FOR v_gift IN
    SELECT DISTINCT gt.id AS gift_transaction_id, gt.recipient_id, gt.stream_id, gt.reward_rule_id
    FROM public.live_gift_transactions gt
    JOIN public.live_spark_spend_allocations a ON a.gift_transaction_id = gt.id
    JOIN public.live_spark_lots l ON l.id = a.lot_id
    WHERE l.purchase_id = v_purchase.id
      AND gt.reward_rule_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM public.live_spark_spend_allocations a2
        JOIN public.live_spark_lots l2 ON l2.id = a2.lot_id
        JOIN public.live_spark_purchases p2 ON p2.id = l2.purchase_id
        WHERE a2.gift_transaction_id = gt.id
          AND (p2.provider_fee_status <> 'verified' OR p2.status <> 'paid')
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.live_creator_earnings_ledger e
        WHERE e.gift_transaction_id = gt.id AND e.entry_type = 'earning'
      )
    ORDER BY gt.id
  LOOP
    SELECT * INTO v_rule FROM public.live_creator_reward_rules WHERE id = v_gift.reward_rule_id;
    IF NOT FOUND THEN CONTINUE; END IF;

    SELECT COALESCE(sum(purchase_value_minor), 0)::bigint INTO v_gross
    FROM public.live_spark_spend_allocations
    WHERE gift_transaction_id = v_gift.gift_transaction_id;
    IF v_gross <= 0 THEN CONTINUE; END IF;

    v_creator_net := FLOOR(v_gross::numeric * v_rule.creator_share_bps / 10000)::bigint;
    v_platform_fee := v_gross - v_creator_net;
    IF v_creator_net <= 0 THEN CONTINUE; END IF;

    INSERT INTO public.live_creator_earnings_ledger
      (creator_id, stream_id, gift_transaction_id, reward_rule_id, entry_type,
       gross_minor, platform_fee_minor, net_minor, currency, status, available_at,
       idempotency_key, reference_id, note)
    VALUES
      (v_gift.recipient_id, v_gift.stream_id, v_gift.gift_transaction_id, v_rule.id, 'earning',
       v_gross, v_platform_fee, v_creator_net, 'NGN', 'pending',
       now() + make_interval(hours => v_rule.clearance_hours),
       'live-earn:' || v_gift.gift_transaction_id::text, v_gift.gift_transaction_id,
       'Creator share released after verified Apple App Store proceeds reconciliation')
    ON CONFLICT (idempotency_key) DO NOTHING;
    IF FOUND THEN v_created := v_created + 1; END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'replayed', false,
    'purchaseId', v_purchase.id,
    'providerFeeMinor', p_provider_fee_minor,
    'earningsCreated', v_created
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.reconcile_live_apple_provider_fee(text, bigint)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_live_apple_provider_fee(text, bigint)
  TO service_role;

COMMENT ON FUNCTION public.reconcile_live_apple_provider_fee(text, bigint) IS
  'Service-role-only settlement reconciliation for Apple App Store proceeds. Creator earnings from gifts funded by an Apple purchase remain withheld until the actual provider fee is reconciled; the function then releases eligible earnings using the reward rule captured when each gift was sent.';


COMMIT;
