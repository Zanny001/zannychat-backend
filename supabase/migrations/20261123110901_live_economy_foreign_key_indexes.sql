-- Cover the remaining foreign keys reported by Supabase performance advisors.
-- These indexes support joins and parent-row deletes without changing data or access.
BEGIN;

CREATE INDEX IF NOT EXISTS live_gift_transactions_gift_id_idx
  ON public.live_gift_transactions (gift_id);

CREATE INDEX IF NOT EXISTS live_pk_battles_created_by_idx
  ON public.live_pk_battles (created_by);

CREATE INDEX IF NOT EXISTS live_pk_battles_creator_b_idx
  ON public.live_pk_battles (creator_b_id);

CREATE INDEX IF NOT EXISTS live_pk_battles_winner_id_idx
  ON public.live_pk_battles (winner_id);

COMMIT;
