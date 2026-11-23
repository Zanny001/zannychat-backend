-- Keep the Sparks source ledger in lockstep with every grant and gift spend.
BEGIN;
ALTER TABLE public.live_spark_lots ADD COLUMN IF NOT EXISTS reference_id uuid;
ALTER TABLE public.live_spark_lots DROP CONSTRAINT IF EXISTS live_spark_lots_source_check;
ALTER TABLE public.live_spark_lots ADD CONSTRAINT live_spark_lots_source_check
  CHECK (source IN ('purchase', 'promotion', 'support_adjustment', 'legacy'));

INSERT INTO public.live_spark_lots(user_id, source, granted_sparks, remaining_sparks)
SELECT user_id, 'legacy', balance_sparks, balance_sparks
FROM public.live_gift_wallets
WHERE balance_sparks > 0
  AND NOT EXISTS (SELECT 1 FROM public.live_spark_lots l WHERE l.user_id = live_gift_wallets.user_id)
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION public.grant_live_sparks(
  p_user_id uuid, p_amount bigint, p_reference_type text, p_reference_id uuid,
  p_idempotency_key text, p_note text DEFAULT NULL
) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_balance bigint;
  v_existing public.live_gift_ledger%ROWTYPE;
BEGIN
  IF p_user_id IS NULL OR p_amount IS NULL OR p_amount < 1 OR p_amount > 100000
     OR p_reference_type IS NULL OR p_reference_type NOT IN ('promotion', 'support_adjustment')
     OR p_idempotency_key IS NULL OR length(p_idempotency_key) NOT BETWEEN 8 AND 128 THEN
    RAISE EXCEPTION 'invalid LIVE Sparks grant' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text || ':' || p_idempotency_key, 0));
  SELECT * INTO v_existing FROM public.live_gift_ledger
    WHERE user_id = p_user_id AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.entry_type <> 'grant' OR v_existing.amount_sparks <> p_amount
       OR v_existing.reference_type <> p_reference_type
       OR v_existing.reference_id IS DISTINCT FROM p_reference_id THEN
      RAISE EXCEPTION 'idempotency key already used for another ledger entry' USING ERRCODE = '23505';
    END IF;
    RETURN v_existing.balance_after;
  END IF;
  INSERT INTO public.live_gift_wallets(user_id, balance_sparks)
    VALUES (p_user_id, 0) ON CONFLICT (user_id) DO NOTHING;
  UPDATE public.live_gift_wallets SET balance_sparks = balance_sparks + p_amount, updated_at = now()
    WHERE user_id = p_user_id RETURNING balance_sparks INTO v_balance;
  INSERT INTO public.live_gift_ledger
    (user_id, entry_type, amount_sparks, balance_after, reference_type, reference_id, idempotency_key, note)
  VALUES (p_user_id, 'grant', p_amount, v_balance, p_reference_type, p_reference_id, p_idempotency_key, p_note);
  INSERT INTO public.live_spark_lots(user_id, source, reference_id, granted_sparks, remaining_sparks)
    VALUES (p_user_id, p_reference_type, p_reference_id, p_amount, p_amount);
  RETURN v_balance;
END;
$function$;

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
  v_remaining bigint;
  v_take bigint;
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

  -- Free promotional credits are consumed before purchased credits. Every lot update
  -- and the aggregate wallet debit share this transaction and roll back together.
  v_remaining := v_total;
  FOR v_lot IN
    SELECT id, remaining_sparks FROM public.live_spark_lots
    WHERE user_id = p_sender_id AND remaining_sparks > 0
    ORDER BY CASE source WHEN 'promotion' THEN 0 WHEN 'support_adjustment' THEN 1
      WHEN 'legacy' THEN 2 ELSE 3 END, created_at, id FOR UPDATE
  LOOP
    EXIT WHEN v_remaining = 0;
    v_take := LEAST(v_remaining, v_lot.remaining_sparks);
    UPDATE public.live_spark_lots SET remaining_sparks = remaining_sparks - v_take WHERE id = v_lot.id;
    v_remaining := v_remaining - v_take;
  END LOOP;
  IF v_remaining > 0 THEN
    RAISE EXCEPTION 'LIVE Sparks source ledger is inconsistent' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.live_gift_wallets SET balance_sparks = balance_sparks - v_total, updated_at = now()
    WHERE user_id = p_sender_id RETURNING balance_sparks INTO v_balance;
  INSERT INTO public.live_gift_transactions
    (sender_id, recipient_id, stream_id, gift_id, quantity, total_sparks, score_points, battle_id, idempotency_key)
  VALUES (p_sender_id, p_recipient_id, p_stream_id, p_gift_id, p_quantity, v_total, v_points,
    v_effective_battle_id, p_idempotency_key) RETURNING id INTO v_transaction_id;
  INSERT INTO public.live_gift_ledger
    (user_id, entry_type, amount_sparks, balance_after, reference_type, reference_id, idempotency_key)
  VALUES (p_sender_id, 'spend', v_total, v_balance, 'gift', v_transaction_id, 'gift:' || v_transaction_id::text);
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
    'scorePoints', v_points, 'replayed', false);
END;
$function$;

COMMIT;
