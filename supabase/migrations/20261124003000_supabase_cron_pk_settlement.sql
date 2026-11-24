-- Keep PK settlement running from the database scheduler even when the free Render web service is asleep.
BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;

GRANT USAGE ON SCHEMA cron TO postgres;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA cron TO postgres;

SELECT cron.schedule(
  'zannychat-live-pk-settlement',
  '* * * * *',
  'SELECT public.reconcile_live_pk_battle_settlement(100);'
);

COMMIT;
