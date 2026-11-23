-- Supabase project default privileges can grant broad table rights to service_role.
-- LIVE economy mutations must remain exclusively inside audited SECURITY DEFINER RPCs.
BEGIN;
REVOKE ALL PRIVILEGES ON TABLE
  public.live_gift_catalog,
  public.live_gift_wallets,
  public.live_gift_ledger,
  public.live_gift_transactions,
  public.live_pk_battles
FROM PUBLIC, anon, authenticated, service_role;

GRANT SELECT ON TABLE
  public.live_gift_catalog,
  public.live_gift_wallets,
  public.live_gift_ledger,
  public.live_gift_transactions,
  public.live_pk_battles
TO service_role;
COMMIT;
