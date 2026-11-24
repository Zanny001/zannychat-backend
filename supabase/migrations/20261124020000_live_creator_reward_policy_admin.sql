-- Restricted, append-only administration for server-owned LIVE creator reward rules.
BEGIN;

CREATE TABLE IF NOT EXISTS public.live_creator_reward_rule_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  action text NOT NULL CHECK (action IN ('draft_created', 'activated')),
  previous_rule_id uuid REFERENCES public.live_creator_reward_rules(id) ON DELETE RESTRICT,
  rule_id uuid NOT NULL REFERENCES public.live_creator_reward_rules(id) ON DELETE RESTRICT,
  creator_share_bps integer NOT NULL CHECK (creator_share_bps BETWEEN 1 AND 10000),
  clearance_hours integer NOT NULL CHECK (clearance_hours BETWEEN 0 AND 720),
  minimum_withdrawal_minor bigint NOT NULL CHECK (minimum_withdrawal_minor > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.live_creator_reward_rule_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.live_creator_reward_rule_audit FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.live_creator_reward_rule_audit TO service_role;

CREATE OR REPLACE FUNCTION public.prevent_live_creator_reward_rule_audit_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
  RAISE EXCEPTION 'creator reward rule audit is append-only' USING ERRCODE = '55000';
END;
$function$;
DROP TRIGGER IF EXISTS live_creator_reward_rule_audit_append_only ON public.live_creator_reward_rule_audit;
CREATE TRIGGER live_creator_reward_rule_audit_append_only
  BEFORE UPDATE OR DELETE ON public.live_creator_reward_rule_audit
  FOR EACH ROW EXECUTE FUNCTION public.prevent_live_creator_reward_rule_audit_mutation();

CREATE OR REPLACE FUNCTION public.create_live_creator_reward_rule(
  p_admin_id uuid, p_creator_share_bps integer, p_clearance_hours integer,
  p_minimum_withdrawal_minor bigint
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE v_rule public.live_creator_reward_rules%ROWTYPE;
BEGIN
  IF p_admin_id IS NULL OR p_creator_share_bps NOT BETWEEN 1 AND 10000
     OR p_clearance_hours NOT BETWEEN 0 AND 720
     OR p_minimum_withdrawal_minor IS NULL OR p_minimum_withdrawal_minor <= 0
     OR p_minimum_withdrawal_minor > 9007199254740991 THEN
    RAISE EXCEPTION 'invalid creator reward rule' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM auth.users WHERE id = p_admin_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'admin account not found' USING ERRCODE = 'P0002'; END IF;

  INSERT INTO public.live_creator_reward_rules
    (currency, creator_share_bps, clearance_hours, minimum_withdrawal_minor, is_active, created_by)
  VALUES ('NGN', p_creator_share_bps, p_clearance_hours, p_minimum_withdrawal_minor, false, p_admin_id)
  RETURNING * INTO v_rule;

  INSERT INTO public.live_creator_reward_rule_audit
    (admin_id, action, rule_id, creator_share_bps, clearance_hours, minimum_withdrawal_minor)
  VALUES (p_admin_id, 'draft_created', v_rule.id, v_rule.creator_share_bps,
    v_rule.clearance_hours, v_rule.minimum_withdrawal_minor);

  RETURN jsonb_build_object('id', v_rule.id, 'currency', v_rule.currency,
    'creatorShareBps', v_rule.creator_share_bps, 'clearanceHours', v_rule.clearance_hours,
    'minimumWithdrawalMinor', v_rule.minimum_withdrawal_minor,
    'isActive', v_rule.is_active, 'createdAt', v_rule.created_at);
END;
$function$;

CREATE OR REPLACE FUNCTION public.activate_live_creator_reward_rule(
  p_admin_id uuid, p_rule_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_rule public.live_creator_reward_rules%ROWTYPE;
  v_previous_id uuid;
BEGIN
  IF p_admin_id IS NULL OR p_rule_id IS NULL THEN
    RAISE EXCEPTION 'admin and rule ids are required' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM auth.users WHERE id = p_admin_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'admin account not found' USING ERRCODE = 'P0002'; END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('live-creator-reward-rule-activation', 0));
  SELECT * INTO v_rule FROM public.live_creator_reward_rules WHERE id = p_rule_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'reward rule draft not found' USING ERRCODE = 'P0002'; END IF;
  SELECT id INTO v_previous_id FROM public.live_creator_reward_rules WHERE is_active = true FOR UPDATE;
  IF v_rule.is_active THEN
    RETURN jsonb_build_object('id', v_rule.id, 'currency', v_rule.currency,
      'creatorShareBps', v_rule.creator_share_bps, 'clearanceHours', v_rule.clearance_hours,
      'minimumWithdrawalMinor', v_rule.minimum_withdrawal_minor, 'isActive', true);
  END IF;

  UPDATE public.live_creator_reward_rules SET is_active = false WHERE is_active = true;
  UPDATE public.live_creator_reward_rules SET is_active = true WHERE id = p_rule_id
    RETURNING * INTO v_rule;

  INSERT INTO public.live_creator_reward_rule_audit
    (admin_id, action, previous_rule_id, rule_id, creator_share_bps, clearance_hours, minimum_withdrawal_minor)
  VALUES (p_admin_id, 'activated', v_previous_id, v_rule.id, v_rule.creator_share_bps,
    v_rule.clearance_hours, v_rule.minimum_withdrawal_minor);

  RETURN jsonb_build_object('id', v_rule.id, 'currency', v_rule.currency,
    'creatorShareBps', v_rule.creator_share_bps, 'clearanceHours', v_rule.clearance_hours,
    'minimumWithdrawalMinor', v_rule.minimum_withdrawal_minor,
    'isActive', v_rule.is_active, 'createdAt', v_rule.created_at);
END;
$function$;

REVOKE ALL ON FUNCTION public.prevent_live_creator_reward_rule_audit_mutation()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.create_live_creator_reward_rule(uuid, integer, integer, bigint)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.activate_live_creator_reward_rule(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_live_creator_reward_rule(uuid, integer, integer, bigint)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.activate_live_creator_reward_rule(uuid, uuid)
  TO service_role;
COMMIT;
