const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('LIVE purchase risk migration freezes Sparks and creator earnings on unresolved refunds or disputes', () => {
  const migration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261123130604_live_purchase_risk_events_20261123130000.sql'), 'utf8');
  assert.match(migration, /live_purchase_risk_events/);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /REVOKE ALL ON public\.live_purchase_risk_events FROM PUBLIC, anon, authenticated/);
  assert.match(migration, /GRANT ALL ON public\.live_purchase_risk_events TO service_role/);
  assert.match(migration, /record_live_purchase_risk_event/);
  assert.match(migration, /risk_held_sparks/);
  assert.match(migration, /risk_hold_reason = 'paystack_risk'/);
  assert.match(migration, /e\.risk_hold_reason = 'paystack_risk'/);
  assert.match(migration, /balance_sparks = balance_sparks - v_remaining/);
  assert.match(migration, /status = 'held'/);
  assert.match(migration, /NOT EXISTS \([\s\S]*p2\.status IN \('disputed', 'refunded'\)/);
  assert.match(migration, /refund\.processed/);
  assert.match(migration, /charge\.dispute\.resolve/);
  assert.match(migration, /manualReviewRequired/);
});

test('partial refunds remain held for manual reconciliation rather than silently revoking or releasing the full purchase', () => {
  const migration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261123130604_live_purchase_risk_events_20261123130000.sql'), 'utf8');
  assert.match(migration, /IF NOT v_full_refund THEN[\s\S]*manualReviewRequired/);
  assert.match(migration, /Partial refunds require operator review/);
});

test('LIVE dispute risk ledger stores provider-supplied response deadlines', () => {
  const migration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261123131458_live_purchase_risk_due_at_20261123131500.sql'), 'utf8');
  assert.match(migration, /provider_due_at timestamptz/);
  assert.match(migration, /live_purchase_risk_events_open_dispute_due_idx/);
});
