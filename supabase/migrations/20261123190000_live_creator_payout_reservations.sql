-- Creator payouts require an explicit verified eligibility record, a verified bank
-- recipient, an active reward policy and an atomic reservation of available earnings.
BEGIN;

CREATE TABLE IF NOT EXISTS public.live_creator_payout_profiles (
  creator_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  verification_status text NOT NULL DEFAULT 'unverified'
    CHECK (verification_status IN ('unverified', 'pending', 'verified', 'rejected')),
  verification_provider text,
  verification_reference text,
  verified_at timestamptz,
  payout_hold boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.live_creator_payout_profiles ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.live_creator_payout_profiles FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.live_creator_payout_profiles TO service_role;

CREATE OR REPLACE FUNCTION public.request_live_creator_payout(
  p_creator_id uuid,
  p_beneficiary_id uuid,
  p_amount_minor bigint,
  p_provider_reference text
) RETURNS public.live_creator_payouts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_profile public.live_creator_payout_profiles%ROWTYPE;
  v_beneficiary public.live_payout_beneficiaries%ROWTYPE;
  v_rule public.live_creator_reward_rules%ROWTYPE;
  v_payout public.live_creator_payouts%ROWTYPE;
  v_available bigint;
BEGIN
  IF p_creator_id IS NULL OR p_beneficiary_id IS NULL
     OR p_amount_minor IS NULL OR p_amount_minor <= 0
     OR p_provider_reference IS NULL OR length(p_provider_reference) NOT BETWEEN 8 AND 128 THEN
    RAISE EXCEPTION 'invalid creator payout request' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_creator_id::text || ':live-payout', 0));

  SELECT * INTO v_profile FROM public.live_creator_payout_profiles
    WHERE creator_id = p_creator_id FOR UPDATE;
  IF NOT FOUND OR v_profile.verification_status <> 'verified' OR v_profile.payout_hold THEN
    RAISE EXCEPTION 'creator payout identity verification is required or account is on hold' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_beneficiary FROM public.live_payout_beneficiaries
    WHERE id = p_beneficiary_id AND creator_id = p_creator_id
      AND status = 'verified' AND currency = 'NGN' FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'a verified bank beneficiary is required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_rule FROM public.live_creator_reward_rules
    WHERE is_active = true ORDER BY created_at DESC LIMIT 1 FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'creator reward policy is not configured' USING ERRCODE = 'P0001'; END IF;
  IF p_amount_minor < v_rule.minimum_withdrawal_minor THEN
    RAISE EXCEPTION 'withdrawal is below the configured minimum' USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(SUM(net_minor), 0) INTO v_available
  FROM public.live_creator_earnings_ledger
  WHERE creator_id = p_creator_id AND entry_type = 'earning' AND status = 'available';

  SELECT v_available
    - COALESCE((SELECT SUM(net_minor) FROM public.live_creator_earnings_ledger
      WHERE creator_id = p_creator_id AND entry_type = 'reversal' AND status = 'reversed'), 0)
    - COALESCE((SELECT SUM(amount_minor) FROM public.live_creator_payouts
      WHERE creator_id = p_creator_id AND status IN ('requested', 'processing', 'paid')), 0)
    INTO v_available;

  IF v_available < p_amount_minor THEN
    RAISE EXCEPTION 'insufficient available creator earnings' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.live_creator_payouts
    (creator_id, beneficiary_id, amount_minor, currency, status, provider, provider_reference)
  VALUES
    (p_creator_id, p_beneficiary_id, p_amount_minor, 'NGN', 'requested', 'paystack', p_provider_reference)
  RETURNING * INTO v_payout;

  RETURN v_payout;
END;
$function$;

REVOKE ALL ON FUNCTION public.request_live_creator_payout(uuid, uuid, bigint, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.request_live_creator_payout(uuid, uuid, bigint, text)
  TO service_role;

COMMENT ON TABLE public.live_creator_payout_profiles IS
  'Server-managed identity eligibility and payout holds. No BVN, NIN or raw identity documents are stored here.';

COMMIT;
