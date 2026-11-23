const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const netMigration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261123210000_live_provider_fee_net_creator_rewards.sql'), 'utf8');
const migration = fs.readFileSync(
  path.join(__dirname, '../supabase/migrations/20261123180000_live_creator_reward_accrual.sql'),
  'utf8',
);

test('creator reward rules are server-owned and inactive until commercial policy is configured', () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.live_creator_reward_rules/);
  assert.match(migration, /creator_share_bps integer NOT NULL CHECK \(creator_share_bps BETWEEN 1 AND 10000\)/);
  assert.match(migration, /clearance_hours integer NOT NULL CHECK/);
  assert.match(migration, /minimum_withdrawal_minor bigint NOT NULL/);
  assert.match(migration, /is_active boolean NOT NULL DEFAULT false/);
  assert.match(migration, /one_active_idx/);
  assert.match(migration, /REVOKE ALL ON public\.live_creator_reward_rules[\s\S]*FROM PUBLIC, anon, authenticated/);
});

test('gift transactions record the source of spent Sparks and only purchased Sparks can create cash earnings', () => {
  assert.match(migration, /purchased_sparks_spent bigint NOT NULL DEFAULT 0/);
  assert.match(migration, /promotional_sparks_spent bigint NOT NULL DEFAULT 0/);
  assert.match(migration, /legacy_sparks_spent bigint NOT NULL DEFAULT 0/);
  assert.match(migration, /live_spark_spend_allocations/);
  assert.match(migration, /p\.status = 'paid'/);
  assert.match(migration, /v_eligible_gross := v_eligible_gross \+ v_purchase_value/);
  assert.match(migration, /creator_share_bps/);
  assert.match(migration, /status, available_at/);
  assert.match(migration, /now\(\) \+ make_interval\(hours => v_rule\.clearance_hours\)/);
  assert.match(migration, /promotional_sparks_spent/);
  assert.match(migration, /Creator share from verified purchased Sparks gifts/);
});

test('PK points remain gift-point based and separate from creator cash earnings', () => {
  assert.match(migration, /score_a = score_a \+ v_points/);
  assert.match(migration, /score_b = score_b \+ v_points/);
  assert.match(migration, /creatorEarningCreated/);
  assert.match(migration, /scorePoints/);
});

test('creator reward base deducts the exact verified Paystack fee before sharing net purchase value', () => {
  assert.match(netMigration, /provider_fee_minor bigint NOT NULL DEFAULT 0/);
  assert.match(netMigration, /provider_fee_minor >= 0 AND provider_fee_minor < amount_minor/);
  assert.match(netMigration, /amount_minor - v_purchase\.provider_fee_minor/);
});
