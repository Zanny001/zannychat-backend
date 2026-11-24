const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migration = fs.readFileSync(
  path.join(__dirname, '../supabase/migrations/20261124002000_live_pk_battle_settlement_worker.sql'),
  'utf8',
);

test('PK settlement RPC only closes stale challenges, elapsed matches, or matches whose LIVE ended', () => {
  assert.match(migration, /b\.status IN \('pending', 'accepted', 'live'\)/);
  assert.match(migration, /s\.status IS DISTINCT FROM 'live'/);
  assert.match(migration, /b\.status = 'pending'.*interval '2 minutes'/);
  assert.match(migration, /b\.status = 'accepted'.*interval '10 minutes'/);
  assert.match(migration, /b\.status = 'live'.*b\.ends_at <= now\(\)/);
});

test('PK winner is determined only from server-owned gift scores after a timed battle ends', () => {
  assert.match(migration, /WHEN stale\.previous_status = 'live' THEN 'ended'/);
  assert.match(migration, /WHEN stale\.score_a > stale\.score_b THEN stale\.creator_a_id/);
  assert.match(migration, /WHEN stale\.score_b > stale\.score_a THEN stale\.creator_b_id/);
  assert.match(migration, /ELSE NULL/);
});

test('PK settlement RPC is locked, bounded and service-role-only', () => {
  assert.match(migration, /FOR UPDATE OF b SKIP LOCKED/);
  assert.match(migration, /LIMIT p_limit/);
  assert.match(migration, /p_limit > 500/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.reconcile_live_pk_battle_settlement\(integer\)[\s\S]*FROM PUBLIC, anon, authenticated/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.reconcile_live_pk_battle_settlement\(integer\)[\s\S]*TO service_role/);
});
