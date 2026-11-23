BEGIN;
CREATE INDEX IF NOT EXISTS live_creator_earnings_gift_transaction_idx
  ON public.live_creator_earnings_ledger(gift_transaction_id);
CREATE INDEX IF NOT EXISTS live_creator_earnings_reward_rule_idx
  ON public.live_creator_earnings_ledger(reward_rule_id);
CREATE INDEX IF NOT EXISTS live_creator_payouts_beneficiary_idx
  ON public.live_creator_payouts(beneficiary_id);
CREATE INDEX IF NOT EXISTS live_creator_reward_rules_created_by_idx
  ON public.live_creator_reward_rules(created_by);
COMMIT;
