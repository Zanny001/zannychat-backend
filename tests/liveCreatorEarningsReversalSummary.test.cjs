const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migration = fs.readFileSync(
  path.join(__dirname, '../supabase/migrations/20261124001000_live_creator_earnings_reversal_summary.sql'),
  'utf8',
);

test('creator earnings summary subtracts reversed earnings before displaying withdrawable balance', () => {
  assert.match(migration, /SUM\(net_minor\) FILTER \(WHERE entry_type = 'reversal' AND status = 'reversed'\)/);
  assert.match(migration, /v_available - v_reversed - v_processing - v_paid_out/);
});

test('creator earnings summary keeps payout reservation deductions aligned with payout RPC', () => {
  assert.match(migration, /status IN \('requested', 'processing'\)/);
  assert.match(migration, /status = 'paid'/);
  assert.match(migration, /GREATEST\(0, v_available - v_reversed - v_processing - v_paid_out\)/);
});

test('creator earnings summary remains service-role-only', () => {
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.get_live_creator_earnings_summary\(uuid\)[\s\S]*FROM PUBLIC, anon, authenticated/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.get_live_creator_earnings_summary\(uuid\)[\s\S]*TO service_role/);
});
