const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const route = fs.readFileSync(path.join(__dirname, '../src/routes/livePurchases.js'), 'utf8');
const verifier = fs.readFileSync(path.join(__dirname, '../src/services/googlePlayBilling.js'), 'utf8');
const migration = fs.readFileSync(
  path.join(__dirname, '../supabase/migrations/20261123230000_live_google_play_sparks_fulfilment.sql'),
  'utf8',
);

test('native Play verification requires auth, an active server-owned package and a configured provider', () => {
  assert.match(route, /router\.use\(requireAuth/);
  assert.match(route, /LIVE_GOOGLE_PLAY_BILLING_ENABLED === 'true'/);
  assert.match(route, /GOOGLE_PLAY_SERVICE_ACCOUNT_JSON/);
  assert.match(route, /\.eq\('provider', 'google_play'\)[\s\S]*\.eq\('currency', 'NGN'\)[\s\S]*\.eq\('is_active', true\)/);
  assert.match(route, /obfuscatedAccountId: sha256Hex\(req\.user\.id\)/);
  assert.doesNotMatch(route, /amount_minor:\s*req\.body/);
  assert.doesNotMatch(route, /sparks:\s*req\.body/);
});

test('native Play verification fulfils through the existing atomic ledger RPC before consuming', () => {
  const fulfil = route.indexOf("rpc('fulfill_live_spark_purchase'");
  const consume = route.indexOf('consumeProductPurchase', fulfil);
  assert.ok(fulfil > 0);
  assert.ok(consume > fulfil);
  assert.match(route, /provider_transaction_id/);
  assert.match(route, /gplay:' \+ sha256Hex\(purchaseToken\)/);
  assert.match(route, /STORE_TRANSACTION_FINALIZATION_PENDING/);
  assert.match(route, /consumptionState === 1 && \(!existing \|\| existing\.status !== 'paid'\)/);
});

test('Google verifier requires a completed purchase, account binding and Nigeria Play region', () => {
  assert.match(verifier, /purchase\?\.purchaseState !== 0/);
  assert.match(verifier, /obfuscatedExternalAccountId !== obfuscatedAccountId/);
  assert.match(verifier, /purchase\?\.regionCode !== 'NG'/);
  assert.match(verifier, /purchases\/products/);
  assert.match(verifier, /:consume/);
  assert.match(verifier, /GOOGLE_PLAY_SCOPE/);
});

test('database fulfilment permits Paystack and Google Play only, remains service-role-only and is idempotent', () => {
  assert.match(migration, /v_purchase\.provider NOT IN \('paystack', 'google_play'\)/);
  assert.match(migration, /p_provider_transaction_id/);
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(migration, /v_purchase\.status = 'paid'/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.fulfill_live_spark_purchase[\s\S]*FROM PUBLIC, anon, authenticated/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.fulfill_live_spark_purchase[\s\S]*TO service_role/);
});
