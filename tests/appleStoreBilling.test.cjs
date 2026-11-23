const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const route = fs.readFileSync(path.join(__dirname, '../src/routes/livePurchases.js'), 'utf8');
const verifier = fs.readFileSync(path.join(__dirname, '../src/services/appleStoreBilling.js'), 'utf8');
const migration = fs.readFileSync(
  path.join(__dirname, '../supabase/migrations/20261123240000_apple_store_sparks_verification.sql'),
  'utf8',
);

test('Apple account binding is stable, UUID-backed and service-role-only', () => {
  assert.match(route, /router\.get\('\/apple\/account-binding'/);
  assert.match(route, /live_apple_account_bindings/);
  assert.match(route, /crypto\.randomUUID\(\)/);
  assert.match(migration, /app_account_token uuid NOT NULL UNIQUE/);
  assert.match(migration, /REVOKE ALL ON public\.live_apple_account_bindings FROM PUBLIC, anon, authenticated/);
  assert.match(migration, /GRANT ALL ON public\.live_apple_account_bindings TO service_role/);
});

test('Apple purchase verification trusts Apple signed JWS and server catalogue only', () => {
  assert.match(verifier, /require\('@apple\/app-store-server-library'\)/);
  assert.match(verifier, /SignedDataVerifier/);
  assert.match(verifier, /verifyAndDecodeTransaction/);
  assert.match(verifier, /APPLE_ROOT_CA_CERTIFICATES_BASE64/);
  assert.match(route, /router\.post\('\/apple\/verify'/);
  assert.match(route, /verifyTransaction\(signedTransaction\)/);
  assert.match(route, /transaction\.appAccountToken/);
  assert.match(route, /transaction\.bundleId/);
  assert.match(route, /transaction\.revocationDate != null/);
  assert.match(route, /\.eq\('provider', 'apple_iap'\)[\s\S]*\.eq\('currency', 'NGN'\)[\s\S]*\.eq\('is_active', true\)/);
  assert.match(route, /minorUnitsFromApplePrice\(transaction\.price, transaction\.currency\)/);
  assert.doesNotMatch(route, /sparks:\s*req\.body/);
  assert.doesNotMatch(route, /amount_minor:\s*req\.body/);
  assert.doesNotMatch(verifier, /verifyReceipt/);
});

test('Apple fulfilment is atomic, idempotent and production rejects sandbox transactions', () => {
  assert.match(route, /verifiedResult\.environment !== 'Production'/);
  assert.match(route, /rpc\('fulfill_live_spark_purchase'/);
  assert.match(route, /transactionKey = 'apple:' \+ sha256Hex/);
  assert.match(route, /ensureLivePurchaseReceipt/);
  assert.match(migration, /v_purchase\.provider NOT IN \('paystack', 'google_play', 'apple_iap'\)/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.fulfill_live_spark_purchase[\s\S]*TO service_role/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.fulfill_live_spark_purchase[\s\S]*FROM PUBLIC, anon, authenticated/);
});
