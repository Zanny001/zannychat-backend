-- Reconcile stale LIVE PK challenges and elapsed battles even when no viewer is polling the battle screen.
BEGIN;

CREATE OR REPLACE FUNCTION public.reconcile_live_pk_battle_settlement(p_limit integer DEFAULT 100)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_reconciled integer := 0;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 500 THEN
    RAISE EXCEPTION 'invalid PK settlement batch size' USING ERRCODE = '22023';
  END IF;

  WITH stale_battles AS (
    SELECT
      b.id,
      b.status AS previous_status,
      b.creator_a_id,
      b.creator_b_id,
      b.score_a,
      b.score_b,
      s.status AS stream_status
    FROM public.live_pk_battles AS b
    JOIN public.live_streams AS s ON s.id = b.stream_id
    WHERE b.status IN ('pending', 'accepted', 'live')
      AND (
        s.status IS DISTINCT FROM 'live'
        OR (b.status = 'pending' AND b.created_at < now() - interval '2 minutes')
        OR (b.status = 'accepted' AND b.created_at < now() - interval '10 minutes')
        OR (b.status = 'live' AND b.ends_at IS NOT NULL AND b.ends_at <= now())
      )
    ORDER BY b.updated_at ASC, b.id ASC
    FOR UPDATE OF b SKIP LOCKED
    LIMIT p_limit
  )
  UPDATE public.live_pk_battles AS b
  SET
    status = CASE
      WHEN stale.stream_status IS DISTINCT FROM 'live' THEN 'cancelled'
      WHEN stale.previous_status = 'live' THEN 'ended'
      ELSE 'cancelled'
    END,
    winner_id = CASE
      WHEN stale.stream_status = 'live' AND stale.previous_status = 'live'
        THEN CASE
          WHEN stale.score_a > stale.score_b THEN stale.creator_a_id
          WHEN stale.score_b > stale.score_a THEN stale.creator_b_id
          ELSE NULL
        END
      ELSE NULL
    END,
    updated_at = now()
  FROM stale_battles AS stale
  WHERE b.id = stale.id;

  GET DIAGNOSTICS v_reconciled = ROW_COUNT;
  RETURN v_reconciled;
END;
$function$;

REVOKE ALL ON FUNCTION public.reconcile_live_pk_battle_settlement(integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_live_pk_battle_settlement(integer)
  TO service_role;

COMMENT ON FUNCTION public.reconcile_live_pk_battle_settlement(integer) IS
  'Service-role-only worker RPC that closes expired or stale PK battles and records winners from server-owned gift points.';

COMMIT;
