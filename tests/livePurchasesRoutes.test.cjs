const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const purchases = fs.readFileSync(path.join(__dirname, '../src/routes/livePurchases.js'), 'utf8');
const webhook = fs.readFileSync(path.join(__dirname, '../src/routes/paystackLiveWebhook.js'), 'utf8');
const index = fs.readFileSync(path.join(__dirname, '../src/index.js'), 'utf8');
const migration = fs.readFileSync(
  path.join(__dirname, '../supabase/migrations/20261123160000_live_monetization_foundation.sql'),
  'utf8',
);

test('Sparks checkout uses an active server-owned package and authenticated account identity', () => {
  assert.match(purchases, /router\.use\(requireAuth/);
  assert.match(purchases, /\.eq\('provider', 'paystack'\)[\s\S]*\.eq\('currency', 'NGN'\)[\s\S]*\.eq\('is_active', true\)/);
  assert.match(purchases, /user_id: req\.user\.id/);
  assert.match(purchases, /email: req\.user\.email/);
  assert.match(purchases, /amount: Number\(purchase\.amount_minor\)/);
  assert.match(purchases, /reference: purchase\.provider_reference/);
  assert.doesNotMatch(purchases, /amount:\s*req\.body/);
  assert.doesNotMatch(purchases, /sparks:\s*req\.body/);
  assert.match(purchases, /PAYMENTS_NOT_CONFIGURED/);
});

test('Paystack webhook authenticates raw bytes and independently verifies the transaction', () => {
  assert.match(webhook, /express\.raw\(\{ type: 'application\/json'/);
  assert.match(webhook, /createHmac\('sha512'/);
  assert.match(webhook, /timingSafeEqual/);
  assert.match(webhook, /api\.paystack\.co\/transaction\/verify/);
  assert.match(webhook, /payload\?\.data\?\.status !== 'success'/);
  assert.match(webhook, /rpc\('fulfill_live_spark_purchase'/);
  assert.match(webhook, /p_amount_minor: Number\(verified\.amount\)/);
  assert.match(webhook, /p_currency: String\(verified\.currency\)/);
});

test('Paystack webhook is mounted before JSON parsing and authenticated checkout after parsing', () => {
  assert.ok(index.indexOf("app.use('/webhooks/paystack/live', paystackLiveWebhookRouter)") < index.indexOf('app.use(express.json'));
  assert.ok(index.indexOf('app.use(express.json') < index.indexOf("app.use('/live/purchases', livePurchasesRouter)"));
});

test('no payment package is enabled by default and payment fulfilment remains service-role-only', () => {
  assert.match(migration, /is_active boolean NOT NULL DEFAULT false/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.fulfill_live_spark_purchase[\s\S]*TO service_role/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.fulfill_live_spark_purchase[\s\S]*FROM PUBLIC, anon, authenticated/);
});
