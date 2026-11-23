const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const route = fs.readFileSync(path.join(__dirname, '../src/routes/livePurchases.js'), 'utf8');
const migration = fs.readFileSync(
  path.join(__dirname, '../supabase/migrations/20261123162500_apple_provider_fee_settlement.sql'),
  'utf8',
);

test('Apple purchase fees remain pending and cannot create premature creator earnings', () => {
  assert.match(route, /provider_fee_status: 'pending'/);
  assert.match(migration, /provider_fee_status text NOT NULL DEFAULT 'verified'/);
  assert.match(migration, /v_pending_provider_fee boolean := false/);
  assert.match(migration, /v_purchase\.provider_fee_status = 'verified'/);
  assert.match(migration, /v_pending_provider_fee := true/);
  assert.match(migration, /NOT v_pending_provider_fee/);
  assert.match(migration, /providerFeePending/);
});

test('the gift-time reward rule is captured for deferred Apple settlement', () => {
  assert.match(migration, /live_gift_transactions[\s\S]*reward_rule_id uuid/);
  assert.match(migration, /UPDATE public\.live_gift_transactions SET reward_rule_id = v_rule\.id/);
  assert.match(migration, /gt\.reward_rule_id/);
  assert.match(migration, /p2\.provider_fee_status <> 'verified' OR p2\.status <> 'paid'/);
});

test('only a service-role reconciliation can release Apple creator earnings after actual fee settlement', () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.reconcile_live_apple_provider_fee/);
  assert.match(migration, /provider_fee_minor = p_provider_fee_minor,[\s\S]*provider_fee_status = 'verified'/);
  assert.match(migration, /purchase_value_minor = FLOOR/);
  assert.match(migration, /Creator share released after verified Apple App Store proceeds reconciliation/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.reconcile_live_apple_provider_fee[\s\S]*FROM PUBLIC, anon, authenticated/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.reconcile_live_apple_provider_fee[\s\S]*TO service_role/);
  assert.doesNotMatch(route, /reconcile_live_apple_provider_fee/);
});

test('the reward-rule foreign key is covered by a partial index', () => {
  const indexMigration = fs.readFileSync(
    path.join(__dirname, '../supabase/migrations/20261123164000_live_gift_reward_rule_fk_index.sql'),
    'utf8',
  );
  assert.match(indexMigration, /CREATE INDEX IF NOT EXISTS live_gift_transactions_reward_rule_id_idx/);
  assert.match(indexMigration, /ON public\.live_gift_transactions\(reward_rule_id\)/);
  assert.match(indexMigration, /WHERE reward_rule_id IS NOT NULL/);
});
