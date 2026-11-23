-- Keep LIVE gift audit rows immutable while preserving the reward rule snapshot.
-- The previous send_live_gift implementation inserted the transaction and then
-- updated reward_rule_id. That UPDATE is rejected by the append-only audit trigger.
-- Select the active rule before the insert and persist it in the original INSERT.

BEGIN;

DO $migration$
DECLARE
  v_definition text;
  v_old_insert text := $old_insert$
  INSERT INTO public.live_gift_transactions
    (sender_id, recipient_id, stream_id, gift_id, quantity, total_sparks, score_points, battle_id,
     purchased_sparks_spent, promotional_sparks_spent, legacy_sparks_spent, idempotency_key)
  VALUES
    (p_sender_id, p_recipient_id, p_stream_id, p_gift_id, p_quantity, v_total, v_points, v_effective_battle_id,
     v_purchased_spent, v_promotional_spent, v_legacy_spent, p_idempotency_key)
  RETURNING id INTO v_transaction_id;
$old_insert$;
  v_new_insert text := $new_insert$
  SELECT * INTO v_rule FROM public.live_creator_reward_rules
    WHERE is_active = true ORDER BY created_at DESC LIMIT 1 FOR SHARE;

  INSERT INTO public.live_gift_transactions
    (sender_id, recipient_id, stream_id, gift_id, quantity, total_sparks, score_points, battle_id, reward_rule_id,
     purchased_sparks_spent, promotional_sparks_spent, legacy_sparks_spent, idempotency_key)
  VALUES
    (p_sender_id, p_recipient_id, p_stream_id, p_gift_id, p_quantity, v_total, v_points, v_effective_battle_id, v_rule.id,
     v_purchased_spent, v_promotional_spent, v_legacy_spent, p_idempotency_key)
  RETURNING id INTO v_transaction_id;
$new_insert$;
  v_old_rule text := $old_rule$
  SELECT * INTO v_rule FROM public.live_creator_reward_rules
    WHERE is_active = true ORDER BY created_at DESC LIMIT 1 FOR SHARE;
  IF FOUND THEN
    UPDATE public.live_gift_transactions SET reward_rule_id = v_rule.id WHERE id = v_transaction_id;
  END IF;
  IF FOUND AND v_eligible_gross > 0 AND NOT v_pending_provider_fee THEN
$old_rule$;
  v_new_rule text := $new_rule$
  IF v_rule.id IS NOT NULL AND v_eligible_gross > 0 AND NOT v_pending_provider_fee THEN
$new_rule$;
  v_updated_definition text;
BEGIN
  SELECT pg_get_functiondef(
    'public.send_live_gift(uuid,uuid,uuid,text,integer,text)'::regprocedure
  ) INTO v_definition;

  IF v_definition IS NULL
     OR position(v_old_insert IN v_definition) = 0
     OR position(v_old_rule IN v_definition) = 0 THEN
    RAISE EXCEPTION 'send_live_gift definition differs from the audited source; refusing an unsafe rewrite';
  END IF;

  v_updated_definition := replace(v_definition, v_old_insert, v_new_insert);
  v_updated_definition := replace(v_updated_definition, v_old_rule, v_new_rule);

  IF position('UPDATE public.live_gift_transactions SET reward_rule_id' IN v_updated_definition) > 0 THEN
    RAISE EXCEPTION 'send_live_gift still attempts to mutate the append-only gift audit row';
  END IF;

  EXECUTE v_updated_definition;

  IF position(
    'battle_id, reward_rule_id' IN
    pg_get_functiondef('public.send_live_gift(uuid,uuid,uuid,text,integer,text)'::regprocedure)
  ) = 0 THEN
    RAISE EXCEPTION 'send_live_gift did not persist reward_rule_id in its initial insert';
  END IF;
END;
$migration$;

COMMIT;
