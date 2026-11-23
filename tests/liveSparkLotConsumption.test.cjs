const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const migration = fs.readFileSync(
  path.join(__dirname, '../supabase/migrations/20261123170000_live_spark_lot_consumption.sql'),
  'utf8',
);

test('promotional grants create source-aware Sparks lots exactly once', () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.grant_live_sparks/);
  assert.match(migration, /INSERT INTO public\.live_spark_lots\(user_id, source, reference_id, granted_sparks, remaining_sparks\)/);
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(migration, /v_existing\.reference_id IS DISTINCT FROM p_reference_id/);
});

test('gift spending consumes promotional credits before paid credits atomically', () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.send_live_gift/);
  assert.match(migration, /ORDER BY CASE source WHEN 'promotion' THEN 0 WHEN 'support_adjustment' THEN 1/);
  assert.match(migration, /WHEN 'legacy' THEN 2 ELSE 3 END/);
  assert.match(migration, /FOR UPDATE/);
  assert.match(migration, /remaining_sparks = remaining_sparks - v_take/);
  assert.match(migration, /LIVE Sparks source ledger is inconsistent/);
  assert.match(migration, /balance_sparks = balance_sparks - v_total/);
  assert.match(migration, /score_a = score_a \+ v_points/);
  assert.match(migration, /score_b = score_b \+ v_points/);
});

test('pre-existing balances are preserved as non-redeemable legacy lots', () => {
  assert.match(migration, /SELECT w.user_id, 'legacy', w.balance_sparks - COALESCE(SUM(l.remaining_sparks), 0)/);
  assert.match(migration, /WHERE balance_sparks > 0/);
  assert.match(migration, /NOT EXISTS \(SELECT 1 FROM public\.live_spark_lots/);
});
