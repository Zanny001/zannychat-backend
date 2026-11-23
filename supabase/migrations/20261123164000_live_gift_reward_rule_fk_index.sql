-- Cover the reward-rule foreign key used by gift-time creator revenue attribution.
BEGIN;
CREATE INDEX IF NOT EXISTS live_gift_transactions_reward_rule_id_idx
  ON public.live_gift_transactions(reward_rule_id)
  WHERE reward_rule_id IS NOT NULL;
COMMIT;
