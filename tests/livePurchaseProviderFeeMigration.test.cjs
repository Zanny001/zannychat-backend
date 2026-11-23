const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migration = fs.readFileSync(
  path.join(__dirname, '../supabase/migrations/20261123231500_live_spark_purchase_provider_fee.sql'),
  'utf8',
);
const route = fs.readFileSync(path.join(__dirname, '../src/routes/livePurchases.js'), 'utf8');

test('purchase provider fee is stored as a bounded minor-currency amount', () => {
  assert.match(migration, /ADD COLUMN IF NOT EXISTS provider_fee_minor bigint NOT NULL DEFAULT 0/);
  assert.match(migration, /provider_fee_minor >= 0 AND provider_fee_minor <= amount_minor/);
});

test('Google Play fulfilment rejects catalogue price drift and persists verified fees', () => {
  assert.match(route, /verified\.amountMinor !== Number\(pack\.amount_minor\)/);
  assert.match(route, /provider_fee_minor: verified\.providerFeeMinor/);
  assert.match(route, /Number\(purchase\.provider_fee_minor\) !== verified\.providerFeeMinor/);
});
