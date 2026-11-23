-- LIVE gifts and PK scoring foundation.
-- Sparks are non-purchasable promotional credits with no cash value or cash-out.
-- All balance mutations and gift sends are server-owned and idempotent.
BEGIN;

CREATE TABLE IF NOT EXISTS public.live_gift_catalog (
  gift_id text PRIMARY KEY CHECK (gift_id ~ '^[a-z][a-z0-9_]{1,39}$'),
  display_name text NOT NULL CHECK (length(trim(display_name)) BETWEEN 2 AND 40),
  emoji text NOT NULL CHECK (length(emoji) BETWEEN 1 AND 16),
  spark_cost integer NOT NULL CHECK (spark_cost > 0 AND spark_cost <= 10000),
  score_points integer NOT NULL CHECK (score_points > 0 AND score_points <= 100000),
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.live_gift_catalog
  (gift_id, display_name, emoji, spark_cost, score_points, sort_order)
VALUES
  ('heart', 'Heart', '💜', 1, 1, 10),
  ('spark', 'Spark', '✨', 5, 5, 20),
  ('crown', 'Crown', '👑', 25, 25, 30),
  ('aurora', 'Aurora', '🌌', 100, 100, 40),
  ('royal_star', 'Royal Star', '🌟', 500, 500, 50)
ON CONFLICT (gift_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.live_gift_wallets (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  balance_sparks bigint NOT NULL DEFAULT 0 CHECK (balance_sparks >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.live_gift_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  entry_type text NOT NULL CHECK (entry_type IN ('grant', 'spend', 'refund', 'adjustment')),
  amount_sparks bigint NOT NULL CHECK (amount_sparks > 0),
  balance_after bigint NOT NULL CHECK (balance_after >= 0),
  reference_type text NOT NULL CHECK (reference_type IN ('promotion', 'gift', 'support_adjustment')),
  reference_id uuid,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS live_gift_ledger_user_created_idx
  ON public.live_gift_ledger (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.live_gift_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  recipient_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  stream_id uuid NOT NULL REFERENCES public.live_streams(id) ON DELETE RESTRICT,
  gift_id text NOT NULL REFERENCES public.live_gift_catalog(gift_id) ON DELETE RESTRICT,
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 20),
  total_sparks bigint NOT NULL CHECK (total_sparks > 0),
  score_points bigint NOT NULL CHECK (score_points > 0),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (sender_id <> recipient_id),
  UNIQUE (sender_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS live_gift_transactions_stream_created_idx
  ON public.live_gift_transactions (stream_id, created_at DESC);
CREATE INDEX IF NOT EXISTS live_gift_transactions_recipient_created_idx
  ON public.live_gift_transactions (recipient_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.live_pk_battles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stream_id uuid NOT NULL REFERENCES public.live_streams(id) ON DELETE CASCADE,
  creator_a_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  creator_b_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'live', 'ended', 'cancelled')),
  score_a bigint NOT NULL DEFAULT 0 CHECK (score_a >= 0),
  score_b bigint NOT NULL DEFAULT 0 CHECK (score_b >= 0),
  duration_seconds integer NOT NULL DEFAULT 300 CHECK (duration_seconds BETWEEN 60 AND 900),
  started_at timestamptz,
  ends_at timestamptz,
  winner_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (creator_a_id <> creator_b_id),
  CHECK (winner_id IS NULL OR winner_id IN (creator_a_id, creator_b_id)),
  CHECK ((status <> 'live') OR (started_at IS NOT NULL AND ends_at IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS live_pk_one_open_battle_per_stream_idx
  ON public.live_pk_battles (stream_id) WHERE status IN ('pending', 'accepted', 'live');
CREATE INDEX IF NOT EXISTS live_pk_battles_creator_history_idx
  ON public.live_pk_battles (creator_a_id, created_at DESC);

ALTER TABLE public.live_gift_transactions
  ADD COLUMN IF NOT EXISTS battle_id uuid REFERENCES public.live_pk_battles(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS live_gift_transactions_battle_created_idx
  ON public.live_gift_transactions (battle_id, created_at DESC)
  WHERE battle_id IS NOT NULL;

ALTER TABLE public.live_gift_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.live_gift_wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.live_gift_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.live_gift_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.live_pk_battles ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.live_gift_catalog, public.live_gift_wallets,
  public.live_gift_ledger, public.live_gift_transactions, public.live_pk_battles
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.live_gift_catalog TO service_role;
GRANT ALL ON public.live_gift_catalog, public.live_gift_wallets,
  public.live_gift_ledger, public.live_gift_transactions, public.live_pk_battles
  TO service_role;


CREATE OR REPLACE FUNCTION public.create_live_pk_battle(
  p_stream_id uuid, p_creator_a_id uuid, p_creator_b_id uuid, p_duration_seconds integer DEFAULT 300
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_stream public.live_streams%ROWTYPE;
  v_battle_id uuid;
BEGIN
  IF p_stream_id IS NULL OR p_creator_a_id IS NULL OR p_creator_b_id IS NULL
     OR p_creator_a_id = p_creator_b_id OR p_duration_seconds NOT BETWEEN 60 AND 900 THEN
    RAISE EXCEPTION 'invalid PK battle request' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_stream FROM public.live_streams WHERE id = p_stream_id FOR UPDATE;
  IF NOT FOUND OR v_stream.status <> 'live' OR v_stream.creator_id <> p_creator_a_id THEN
    RAISE EXCEPTION 'only the active stream creator can create a PK battle' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM public.live_stream_participants
    WHERE stream_id = p_stream_id AND user_id = p_creator_a_id
      AND role = 'creator' AND status = 'joined' AND left_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'creator must be on the LIVE stage' USING ERRCODE = 'P0001'; END IF;
  PERFORM 1 FROM public.live_stream_participants
    WHERE stream_id = p_stream_id AND user_id = p_creator_b_id
      AND role = 'guest' AND status = 'joined' AND left_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'opponent must join this LIVE as a guest first' USING ERRCODE = 'P0001'; END IF;
  UPDATE public.live_pk_battles SET status = 'cancelled', updated_at = now()
    WHERE stream_id = p_stream_id
      AND ((status = 'pending' AND created_at < now() - interval '2 minutes')
        OR (status = 'accepted' AND created_at < now() - interval '10 minutes'));
  INSERT INTO public.live_pk_battles
    (stream_id, creator_a_id, creator_b_id, duration_seconds, created_by)
  VALUES (p_stream_id, p_creator_a_id, p_creator_b_id, p_duration_seconds, p_creator_a_id)
  RETURNING id INTO v_battle_id;
  RETURN v_battle_id;
END;
$$;


CREATE OR REPLACE FUNCTION public.accept_live_pk_battle(p_battle_id uuid, p_creator_id uuid)
RETURNS public.live_pk_battles
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_battle public.live_pk_battles%ROWTYPE;
  v_stream_status text;
BEGIN
  SELECT * INTO v_battle FROM public.live_pk_battles WHERE id = p_battle_id FOR UPDATE;
  IF NOT FOUND OR v_battle.creator_b_id <> p_creator_id OR v_battle.status <> 'pending' THEN
    RAISE EXCEPTION 'PK challenge cannot be accepted by this user' USING ERRCODE = '42501';
  END IF;
  IF v_battle.created_at < now() - interval '2 minutes' THEN
    UPDATE public.live_pk_battles SET status = 'cancelled', updated_at = now()
      WHERE id = p_battle_id RETURNING * INTO v_battle;
    RETURN v_battle;
  END IF;
  SELECT status INTO v_stream_status FROM public.live_streams WHERE id = v_battle.stream_id;
  IF v_stream_status <> 'live' THEN
    UPDATE public.live_pk_battles SET status = 'cancelled', updated_at = now()
      WHERE id = p_battle_id RETURNING * INTO v_battle;
    RETURN v_battle;
  END IF;
  PERFORM 1 FROM public.live_stream_participants
    WHERE stream_id = v_battle.stream_id AND user_id = p_creator_id
      AND role = 'guest' AND status = 'joined' AND left_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Guest must remain on the LIVE stage to accept' USING ERRCODE = '42501'; END IF;
  UPDATE public.live_pk_battles SET status = 'accepted', updated_at = now()
    WHERE id = p_battle_id RETURNING * INTO v_battle;
  RETURN v_battle;
END;
$$;

CREATE OR REPLACE FUNCTION public.decline_live_pk_battle(p_battle_id uuid, p_creator_id uuid)
RETURNS public.live_pk_battles
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_battle public.live_pk_battles%ROWTYPE;
BEGIN
  SELECT * INTO v_battle FROM public.live_pk_battles WHERE id = p_battle_id FOR UPDATE;
  IF NOT FOUND OR v_battle.creator_b_id <> p_creator_id OR v_battle.status <> 'pending' THEN
    RAISE EXCEPTION 'PK challenge cannot be declined by this user' USING ERRCODE = '42501';
  END IF;
  UPDATE public.live_pk_battles SET status = 'cancelled', updated_at = now()
    WHERE id = p_battle_id RETURNING * INTO v_battle;
  RETURN v_battle;
END;
$$;

CREATE OR REPLACE FUNCTION public.start_live_pk_battle(p_battle_id uuid, p_creator_id uuid)
RETURNS public.live_pk_battles
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_battle public.live_pk_battles%ROWTYPE;
  v_stream_status text;
BEGIN
  SELECT * INTO v_battle FROM public.live_pk_battles WHERE id = p_battle_id FOR UPDATE;
  IF NOT FOUND OR v_battle.creator_a_id <> p_creator_id OR v_battle.status <> 'accepted' THEN
    RAISE EXCEPTION 'PK battle cannot be started by this user' USING ERRCODE = '42501';
  END IF;
  SELECT status INTO v_stream_status FROM public.live_streams WHERE id = v_battle.stream_id;
  IF v_stream_status <> 'live' THEN
    UPDATE public.live_pk_battles SET status = 'cancelled', updated_at = now()
      WHERE id = p_battle_id RETURNING * INTO v_battle;
    RETURN v_battle;
  END IF;
  PERFORM 1 FROM public.live_stream_participants
    WHERE stream_id = v_battle.stream_id AND user_id = v_battle.creator_b_id
      AND role = 'guest' AND status = 'joined' AND left_at IS NULL;
  IF NOT FOUND THEN
    UPDATE public.live_pk_battles SET status = 'cancelled', updated_at = now()
      WHERE id = p_battle_id RETURNING * INTO v_battle;
    RETURN v_battle;
  END IF;
  UPDATE public.live_pk_battles
    SET status = 'live', started_at = now(),
        ends_at = now() + make_interval(secs => duration_seconds), updated_at = now()
    WHERE id = p_battle_id RETURNING * INTO v_battle;
  RETURN v_battle;
END;
$$;

CREATE OR REPLACE FUNCTION public.finish_live_pk_battle(p_battle_id uuid, p_creator_id uuid DEFAULT NULL)
RETURNS public.live_pk_battles
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_battle public.live_pk_battles%ROWTYPE;
BEGIN
  SELECT * INTO v_battle FROM public.live_pk_battles WHERE id = p_battle_id FOR UPDATE;
  IF NOT FOUND OR v_battle.status <> 'live' THEN
    RAISE EXCEPTION 'PK battle is not live' USING ERRCODE = 'P0001';
  END IF;
  IF p_creator_id IS NOT NULL AND p_creator_id <> v_battle.creator_a_id THEN
    RAISE EXCEPTION 'only the battle host can end this PK battle early' USING ERRCODE = '42501';
  END IF;
  IF p_creator_id IS NULL AND now() < v_battle.ends_at THEN
    RAISE EXCEPTION 'PK battle timer has not elapsed' USING ERRCODE = 'P0001';
  END IF;
  UPDATE public.live_pk_battles
    SET status = 'ended',
        winner_id = CASE WHEN score_a > score_b THEN creator_a_id
                         WHEN score_b > score_a THEN creator_b_id ELSE NULL END,
        updated_at = now()
    WHERE id = p_battle_id RETURNING * INTO v_battle;
  RETURN v_battle;
END;
$$;

REVOKE ALL ON FUNCTION public.create_live_pk_battle(uuid, uuid, uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.accept_live_pk_battle(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.decline_live_pk_battle(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.start_live_pk_battle(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finish_live_pk_battle(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_live_pk_battle(uuid, uuid, uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.accept_live_pk_battle(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.decline_live_pk_battle(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.start_live_pk_battle(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_live_pk_battle(uuid, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.grant_live_sparks(
  p_user_id uuid,
  p_amount bigint,
  p_reference_type text,
  p_reference_id uuid,
  p_idempotency_key text,
  p_note text DEFAULT NULL
) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_balance bigint;
  v_existing public.live_gift_ledger%ROWTYPE;
BEGIN
  IF p_user_id IS NULL OR p_amount IS NULL OR p_amount < 1 OR p_amount > 100000
     OR p_reference_type IS NULL OR p_reference_type NOT IN ('promotion', 'support_adjustment')
     OR p_idempotency_key IS NULL OR length(p_idempotency_key) NOT BETWEEN 8 AND 128 THEN
    RAISE EXCEPTION 'invalid LIVE Sparks grant' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_existing FROM public.live_gift_ledger
    WHERE user_id = p_user_id AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.entry_type <> 'grant' OR v_existing.amount_sparks <> p_amount THEN
      RAISE EXCEPTION 'idempotency key already used for another ledger entry' USING ERRCODE = '23505';
    END IF;
    RETURN v_existing.balance_after;
  END IF;

  INSERT INTO public.live_gift_wallets (user_id, balance_sparks)
    VALUES (p_user_id, 0) ON CONFLICT (user_id) DO NOTHING;
  UPDATE public.live_gift_wallets
    SET balance_sparks = balance_sparks + p_amount, updated_at = now()
    WHERE user_id = p_user_id RETURNING balance_sparks INTO v_balance;
  INSERT INTO public.live_gift_ledger
    (user_id, entry_type, amount_sparks, balance_after, reference_type, reference_id, idempotency_key, note)
  VALUES
    (p_user_id, 'grant', p_amount, v_balance, p_reference_type, p_reference_id, p_idempotency_key, p_note);
  RETURN v_balance;
END;
$$;

CREATE OR REPLACE FUNCTION public.send_live_gift(
  p_sender_id uuid,
  p_stream_id uuid,
  p_recipient_id uuid,
  p_gift_id text,
  p_quantity integer,
  p_idempotency_key text,
  p_battle_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_stream public.live_streams%ROWTYPE;
  v_gift public.live_gift_catalog%ROWTYPE;
  v_existing public.live_gift_transactions%ROWTYPE;
  v_balance bigint;
  v_total bigint;
  v_points bigint;
  v_transaction_id uuid;
  v_battle public.live_pk_battles%ROWTYPE;
BEGIN
  IF p_sender_id IS NULL OR p_stream_id IS NULL OR p_recipient_id IS NULL
     OR p_sender_id = p_recipient_id OR p_quantity IS NULL OR p_quantity NOT BETWEEN 1 AND 20
     OR p_idempotency_key IS NULL OR length(p_idempotency_key) NOT BETWEEN 8 AND 128 THEN
    RAISE EXCEPTION 'invalid LIVE gift request' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_existing FROM public.live_gift_transactions
    WHERE sender_id = p_sender_id AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.stream_id <> p_stream_id OR v_existing.recipient_id <> p_recipient_id
       OR v_existing.gift_id <> p_gift_id OR v_existing.quantity <> p_quantity
       OR v_existing.battle_id IS DISTINCT FROM p_battle_id THEN
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
    WHERE stream_id = p_stream_id AND user_id = p_sender_id
      AND status = 'joined' AND left_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'sender must be a joined LIVE participant' USING ERRCODE = '42501'; END IF;

  PERFORM 1 FROM public.live_stream_participants
    WHERE stream_id = p_stream_id AND user_id = p_recipient_id
      AND role IN ('creator', 'guest') AND status = 'joined' AND left_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'recipient is not an active LIVE stage participant' USING ERRCODE = '22023'; END IF;

  SELECT * INTO v_gift FROM public.live_gift_catalog WHERE gift_id = p_gift_id AND is_active = true;
  IF NOT FOUND THEN RAISE EXCEPTION 'LIVE gift is unavailable' USING ERRCODE = '22023'; END IF;
  v_total := v_gift.spark_cost::bigint * p_quantity;
  v_points := v_gift.score_points::bigint * p_quantity;

  INSERT INTO public.live_gift_wallets (user_id, balance_sparks)
    VALUES (p_sender_id, 0) ON CONFLICT (user_id) DO NOTHING;
  SELECT balance_sparks INTO v_balance FROM public.live_gift_wallets
    WHERE user_id = p_sender_id FOR UPDATE;
  IF v_balance < v_total THEN RAISE EXCEPTION 'insufficient LIVE Sparks' USING ERRCODE = 'P0001'; END IF;

  UPDATE public.live_gift_wallets
    SET balance_sparks = balance_sparks - v_total, updated_at = now()
    WHERE user_id = p_sender_id RETURNING balance_sparks INTO v_balance;

  INSERT INTO public.live_gift_transactions
    (sender_id, recipient_id, stream_id, gift_id, quantity, total_sparks, score_points, battle_id, idempotency_key)
  VALUES
    (p_sender_id, p_recipient_id, p_stream_id, p_gift_id, p_quantity, v_total, v_points, p_battle_id, p_idempotency_key)
  RETURNING id INTO v_transaction_id;

  INSERT INTO public.live_gift_ledger
    (user_id, entry_type, amount_sparks, balance_after, reference_type, reference_id, idempotency_key)
  VALUES
    (p_sender_id, 'spend', v_total, v_balance, 'gift', v_transaction_id,
      'gift:' || v_transaction_id::text);

  IF p_battle_id IS NOT NULL THEN
    SELECT * INTO v_battle FROM public.live_pk_battles
      WHERE id = p_battle_id AND stream_id = p_stream_id AND status = 'live'
        AND now() >= started_at AND now() < ends_at
      FOR UPDATE;
    IF NOT FOUND OR p_recipient_id NOT IN (v_battle.creator_a_id, v_battle.creator_b_id) THEN
      RAISE EXCEPTION 'PK battle is not active for this recipient' USING ERRCODE = 'P0001';
    END IF;
    IF p_recipient_id = v_battle.creator_a_id THEN
      UPDATE public.live_pk_battles SET score_a = score_a + v_points, updated_at = now() WHERE id = p_battle_id;
    ELSE
      UPDATE public.live_pk_battles SET score_b = score_b + v_points, updated_at = now() WHERE id = p_battle_id;
    END IF;
  END IF;

  RETURN jsonb_build_object('transactionId', v_transaction_id, 'balanceSparks', v_balance,
    'scorePoints', v_points, 'replayed', false);
END;
$$;

REVOKE ALL ON FUNCTION public.grant_live_sparks(uuid, bigint, text, uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.send_live_gift(uuid, uuid, uuid, text, integer, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.grant_live_sparks(uuid, bigint, text, uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.send_live_gift(uuid, uuid, uuid, text, integer, text, uuid) TO service_role;

COMMENT ON TABLE public.live_gift_wallets IS
  'Server-managed promotional Sparks only; not money, not purchasable, and not redeemable for cash.';
COMMENT ON TABLE public.live_gift_ledger IS
  'Append-only audit ledger for LIVE Sparks grants, gift spends, refunds, and controlled adjustments.';
COMMENT ON TABLE public.live_pk_battles IS
  'Server-scored LIVE PK matches; score increases only from committed gift transactions.';
COMMIT;
