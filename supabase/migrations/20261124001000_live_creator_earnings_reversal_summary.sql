-- Keep the creator earnings dashboard's withdrawable balance identical to the payout reservation calculation.
-- Refunded/disputed purchase reversals must reduce available funds before the user sees them as withdrawable.
BEGIN;

CREATE OR REPLACE FUNCTION public.get_live_creator_earnings_summary(p_creator_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_pending bigint;
  v_available bigint;
  v_held bigint;
  v_lifetime bigint;
  v_paid_out bigint;
  v_processing bigint;
  v_reversed bigint;
  v_minimum bigint;
  v_enabled boolean;
BEGIN
  IF p_creator_id IS NULL THEN
    RAISE EXCEPTION 'creator id is required' USING ERRCODE = '22023';
  END IF;

  UPDATE public.live_creator_earnings_ledger
    SET status = 'available'
    WHERE creator_id = p_creator_id AND entry_type = 'earning'
      AND status = 'pending' AND available_at IS NOT NULL AND available_at <= now();

  SELECT
    COALESCE(SUM(net_minor) FILTER (WHERE entry_type = 'earning' AND status = 'pending'), 0),
    COALESCE(SUM(net_minor) FILTER (WHERE entry_type = 'earning' AND status = 'available'), 0),
    COALESCE(SUM(net_minor) FILTER (WHERE entry_type = 'earning' AND status = 'held'), 0),
    COALESCE(SUM(CASE WHEN entry_type = 'earning' THEN net_minor ELSE -net_minor END), 0),
    COALESCE(SUM(net_minor) FILTER (WHERE entry_type = 'reversal' AND status = 'reversed'), 0)
  INTO v_pending, v_available, v_held, v_lifetime, v_reversed
  FROM public.live_creator_earnings_ledger
  WHERE creator_id = p_creator_id;

  SELECT
    COALESCE(SUM(amount_minor) FILTER (WHERE status = 'paid'), 0),
    COALESCE(SUM(amount_minor) FILTER (WHERE status IN ('requested', 'processing')), 0)
  INTO v_paid_out, v_processing
  FROM public.live_creator_payouts
  WHERE creator_id = p_creator_id;

  SELECT minimum_withdrawal_minor, true INTO v_minimum, v_enabled
  FROM public.live_creator_reward_rules
  WHERE is_active = true
  ORDER BY created_at DESC LIMIT 1;

  RETURN jsonb_build_object(
    'currency', 'NGN',
    'pendingMinor', v_pending,
    'availableMinor', GREATEST(0, v_available - v_reversed - v_processing - v_paid_out),
    'heldMinor', v_held,
    'lifetimeNetMinor', v_lifetime,
    'paidOutMinor', v_paid_out,
    'processingPayoutMinor', v_processing,
    'minimumWithdrawalMinor', v_minimum,
    'earningEnabled', COALESCE(v_enabled, false)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.get_live_creator_earnings_summary(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_live_creator_earnings_summary(uuid)
  TO service_role;

COMMIT;
