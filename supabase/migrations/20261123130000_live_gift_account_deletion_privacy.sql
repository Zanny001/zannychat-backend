-- Preserve LIVE gift audit history without preventing the existing Auth account-deletion flow.
-- Personal identifiers are nulled by FK actions; immutable business fields remain intact.
BEGIN;

ALTER TABLE public.live_gift_ledger
  ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE public.live_gift_ledger
  DROP CONSTRAINT IF EXISTS live_gift_ledger_user_id_fkey;
ALTER TABLE public.live_gift_ledger
  ADD CONSTRAINT live_gift_ledger_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.live_gift_transactions
  ALTER COLUMN sender_id DROP NOT NULL,
  ALTER COLUMN recipient_id DROP NOT NULL,
  ALTER COLUMN stream_id DROP NOT NULL;
ALTER TABLE public.live_gift_transactions
  DROP CONSTRAINT IF EXISTS live_gift_transactions_sender_id_fkey,
  DROP CONSTRAINT IF EXISTS live_gift_transactions_recipient_id_fkey,
  DROP CONSTRAINT IF EXISTS live_gift_transactions_stream_id_fkey,
  DROP CONSTRAINT IF EXISTS live_gift_transactions_battle_id_fkey;
ALTER TABLE public.live_gift_transactions
  ADD CONSTRAINT live_gift_transactions_sender_id_fkey
    FOREIGN KEY (sender_id) REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD CONSTRAINT live_gift_transactions_recipient_id_fkey
    FOREIGN KEY (recipient_id) REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD CONSTRAINT live_gift_transactions_stream_id_fkey
    FOREIGN KEY (stream_id) REFERENCES public.live_streams(id) ON DELETE SET NULL,
  ADD CONSTRAINT live_gift_transactions_battle_id_fkey
    FOREIGN KEY (battle_id) REFERENCES public.live_pk_battles(id) ON DELETE SET NULL;

ALTER TABLE public.live_pk_battles
  ALTER COLUMN creator_a_id DROP NOT NULL,
  ALTER COLUMN creator_b_id DROP NOT NULL,
  ALTER COLUMN created_by DROP NOT NULL;
ALTER TABLE public.live_pk_battles
  DROP CONSTRAINT IF EXISTS live_pk_battles_creator_a_id_fkey,
  DROP CONSTRAINT IF EXISTS live_pk_battles_creator_b_id_fkey,
  DROP CONSTRAINT IF EXISTS live_pk_battles_created_by_fkey;
ALTER TABLE public.live_pk_battles
  ADD CONSTRAINT live_pk_battles_creator_a_id_fkey
    FOREIGN KEY (creator_a_id) REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD CONSTRAINT live_pk_battles_creator_b_id_fkey
    FOREIGN KEY (creator_b_id) REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD CONSTRAINT live_pk_battles_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE OR REPLACE FUNCTION public.prevent_live_gift_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  -- Auth deletion may redact only the personal identifier on a ledger row.
  IF TG_OP = 'UPDATE'
     AND TG_TABLE_NAME = 'live_gift_ledger'
     AND OLD.user_id IS NOT NULL AND NEW.user_id IS NULL
     AND (to_jsonb(NEW) - 'user_id') = (to_jsonb(OLD) - 'user_id')
     AND NOT EXISTS (SELECT 1 FROM auth.users WHERE id = OLD.user_id) THEN
    RETURN NEW;
  END IF;

  -- FK-driven anonymisation may null only references whose parent was deleted.
  -- Amounts, gift, quantity, idempotency key, timestamp and audit identity stay immutable.
  IF TG_OP = 'UPDATE'
     AND TG_TABLE_NAME = 'live_gift_transactions'
     AND (to_jsonb(NEW) - ARRAY['sender_id', 'recipient_id', 'stream_id', 'battle_id'])
         = (to_jsonb(OLD) - ARRAY['sender_id', 'recipient_id', 'stream_id', 'battle_id'])
     AND (
       OLD.sender_id IS DISTINCT FROM NEW.sender_id
       OR OLD.recipient_id IS DISTINCT FROM NEW.recipient_id
       OR OLD.stream_id IS DISTINCT FROM NEW.stream_id
       OR OLD.battle_id IS DISTINCT FROM NEW.battle_id
     )
     AND (
       OLD.sender_id IS NOT DISTINCT FROM NEW.sender_id
       OR (NEW.sender_id IS NULL AND OLD.sender_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM auth.users WHERE id = OLD.sender_id))
     )
     AND (
       OLD.recipient_id IS NOT DISTINCT FROM NEW.recipient_id
       OR (NEW.recipient_id IS NULL AND OLD.recipient_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM auth.users WHERE id = OLD.recipient_id))
     )
     AND (
       OLD.stream_id IS NOT DISTINCT FROM NEW.stream_id
       OR (NEW.stream_id IS NULL AND OLD.stream_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM public.live_streams WHERE id = OLD.stream_id))
     )
     AND (
       OLD.battle_id IS NOT DISTINCT FROM NEW.battle_id
       OR (NEW.battle_id IS NULL AND OLD.battle_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM public.live_pk_battles WHERE id = OLD.battle_id))
     ) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'LIVE gift audit records are append-only' USING ERRCODE = '55000';
END;
$$;

COMMENT ON TABLE public.live_gift_ledger IS
  'Append-only LIVE Sparks ledger. Auth deletion redacts user_id while preserving non-identifying audit amounts and references.';
COMMENT ON TABLE public.live_gift_transactions IS
  'Append-only LIVE gift history. Account/stream deletion nulls personal references but preserves immutable gift and score facts.';

COMMIT;
