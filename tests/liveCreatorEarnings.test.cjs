const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const route = fs.readFileSync(path.join(__dirname, '../src/routes/liveCreatorEarnings.js'), 'utf8');
const index = fs.readFileSync(path.join(__dirname, '../src/index.js'), 'utf8');
const migration = fs.readFileSync(
  path.join(__dirname, '../supabase/migrations/20261123180000_live_creator_reward_accrual.sql'),
  'utf8',
);

test('creator earnings API derives identity from authenticated session and reads server ledgers', () => {
  assert.match(route, /router\.use\(requireAuth/);
  assert.match(route, /p_creator_id: req\.user\.id/);
  assert.match(route, /\.eq\('creator_id', req\.user\.id\)/);
  assert.match(route, /get_live_creator_earnings_summary/);
  assert.match(route, /live_creator_earnings_ledger/);
  assert.ok(index.includes("app.use('/live/creator-earnings', liveCreatorEarningsRouter)"));
});

test('earnings summary separates pending, available, held, paid-out and processing amounts', () => {
  assert.match(migration, /'pendingMinor', v_pending/);
  assert.match(migration, /'availableMinor', GREATEST\(0, v_available - v_processing - v_paid_out\)/);
  assert.match(migration, /'heldMinor', v_held/);
  assert.match(migration, /'paidOutMinor', v_paid_out/);
  assert.match(migration, /'processingPayoutMinor', v_processing/);
  assert.match(migration, /'earningEnabled', COALESCE\(v_enabled, false\)/);
});

test('creator earnings automatically clear after the configured availability timestamp', () => {
  assert.match(migration, /SET status = 'available'/);
  assert.match(migration, /status = 'pending' AND available_at IS NOT NULL AND available_at <= now\(\)/);
});
