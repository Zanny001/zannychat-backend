const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migration = fs.readFileSync(
  path.join(__dirname, '../supabase/migrations/20261124003000_supabase_cron_pk_settlement.sql'),
  'utf8',
);

test('PK settlement has a database-native scheduler independent of Render process uptime', () => {
  assert.match(migration, /CREATE EXTENSION IF NOT EXISTS pg_cron/);
  assert.match(migration, /cron\.schedule\(/);
  assert.match(migration, /'zannychat-live-pk-settlement'/);
  assert.match(migration, /'\* \* \* \* \*'/);
  assert.match(migration, /SELECT public\.reconcile_live_pk_battle_settlement\(100\)/);
});

test('PK settlement scheduler runs only the bounded server-owned settlement RPC', () => {
  assert.match(migration, /GRANT USAGE ON SCHEMA cron TO postgres/);
  assert.match(migration, /GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA cron TO postgres/);
  assert.doesNotMatch(migration, /UPDATE public\.live_pk_battles|INSERT INTO public\.live_pk_battles/);
});
