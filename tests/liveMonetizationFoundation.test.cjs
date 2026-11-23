const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const migration = fs.readFileSync(
  path.join(__dirname, '../supabase/migrations/20261123160000_live_monetization_foundation.sql'),
  'utf8',
);

test('LIVE paid Sparks purchases are server-verified and idempotently fulfilled', () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.live_spark_purchases/);
  assert.match(migration, /provider_reference text NOT NULL UNIQUE/);
  assert.match(migration, /status IN \('pending', 'paid', 'failed', 'refunded', 'disputed'\)/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.fulfill_live_spark_purchase/);
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(migration, /v_purchase\.amount_minor <> p_amount_minor/);
  assert.match(migration, /v_purchase\.currency <> p_currency/);
  assert.match(migration, /v_purchase\.status = 'paid'/);
  assert.match(migration, /'replayed', true/);
  assert.match(migration, /live_spark_lots/);
  assert.match(migration, /reference_type,[\s\S]*'purchase'/);
});

test('LIVE monetisation separates purchased Sparks, creator cash earnings and payouts', () => {
  assert.match(migration, /source IN \('purchase', 'promotion', 'support_adjustment'\)/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.live_creator_earnings_ledger/);
  assert.match(migration, /currency text NOT NULL CHECK \(currency = 'NGN'\)/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.live_payout_beneficiaries/);
  assert.match(migration, /provider_recipient_code text NOT NULL/);
  assert.match(migration, /account_last4 text NOT NULL/);
  assert.doesNotMatch(migration, /account_number\s+text/i);
  assert.doesNotMatch(migration, /bv[nN]\s+text/i);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.live_creator_payouts/);
});

test('LIVE monetisation tables are inaccessible to clients and writes are privileged', () => {
  assert.equal((migration.match(/ENABLE ROW LEVEL SECURITY/g) || []).length, 5);
  assert.match(migration, /REVOKE ALL ON[\s\S]*FROM PUBLIC, anon, authenticated/);
  assert.match(migration, /GRANT ALL ON[\s\S]*TO service_role/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.fulfill_live_spark_purchase[\s\S]*FROM PUBLIC, anon, authenticated/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.fulfill_live_spark_purchase[\s\S]*TO service_role/);
});

test('personal identifiers can be anonymized on account deletion without deleting financial audit records', () => {
  assert.match(migration, /user_id uuid REFERENCES auth\.users\(id\) ON DELETE SET NULL/);
  assert.match(migration, /creator_id uuid REFERENCES auth\.users\(id\) ON DELETE SET NULL/);
  assert.match(migration, /account_last4/);
  assert.match(migration, /provider_recipient_code/);
});
