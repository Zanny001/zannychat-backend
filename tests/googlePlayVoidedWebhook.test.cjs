const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const route = fs.readFileSync(path.join(__dirname, '../src/routes/googlePlayWebhook.js'), 'utf8');
const index = fs.readFileSync(path.join(__dirname, '../src/index.js'), 'utf8');
const migration = fs.readFileSync(
  path.join(__dirname, '../supabase/migrations/20261123235000_live_google_play_voided_purchase_risk.sql'),
  'utf8',
);
const purchaseRoute = fs.readFileSync(path.join(__dirname, '../src/routes/livePurchases.js'), 'utf8');

test('Google Play Pub/Sub webhook requires OIDC audience and service-account identity', () => {
  assert.match(route, /GOOGLE_PLAY_PUBSUB_AUDIENCE/);
  assert.match(route, /GOOGLE_PLAY_PUBSUB_SERVICE_ACCOUNT_EMAIL/);
  assert.match(route, /verifyGooglePubSubOidcToken/);
  assert.match(route, /messageId/);
  assert.match(route, /notification\?\.packageName !== expectedPackageName/);
});

test('only provider-confirmed one-time void notifications can revoke a fulfilled Sparks purchase', () => {
  assert.match(route, /voidedPurchaseNotification/);
  assert.match(route, /Number\(voided\.productType\) !== 2/);
  assert.match(route, /verifyVoidedPurchase/);
  assert.match(route, /gplay:' \+ sha256Hex\(verified\.purchaseToken\)/);
  assert.match(route, /record_live_google_play_voided_purchase/);
  assert.match(route, /status\(503\).*will be retried/s);
  assert.match(purchaseRoute, /provider_order_id: verified\.orderId/);
});

test('Google Play risk migration is idempotent, service-role-only and protects wallet and creator earnings', () => {
  assert.match(migration, /provider IN \('paystack', 'google_play'\)/);
  assert.match(migration, /'google_play\.voided'/);
  assert.match(migration, /provider_order_id/);
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(migration, /risk_held_sparks/);
  assert.match(migration, /live_creator_payouts/);
  assert.match(migration, /payout_hold = true/);
  assert.match(migration, /google_play_risk/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.record_live_google_play_voided_purchase[\s\S]*FROM PUBLIC, anon, authenticated/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.record_live_google_play_voided_purchase[\s\S]*TO service_role/);
});

test('Google Play webhook is mounted after JSON parsing on its dedicated endpoint', () => {
  const parser = index.indexOf("app.use(express.json({ limit: '100kb', strict: true }));");
  const mount = index.indexOf("app.use('/webhooks/google-play', googlePlayWebhookRouter);");
  assert.ok(parser > 0 && mount > parser);
});
