const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const route = fs.readFileSync(path.join(__dirname, '../src/routes/livePurchases.js'), 'utf8');
const verifier = fs.readFileSync(path.join(__dirname, '../src/services/appleStoreBilling.js'), 'utf8');
const migration = fs.readFileSync(
  path.join(__dirname, '../supabase/migrations/20261123161843_apple_store_sparks_verification.sql'),
  'utf8',
);
const notifications = fs.readFileSync(path.join(__dirname, '../src/routes/appleStoreNotifications.js'), 'utf8');
const refundMigration = fs.readFileSync(
  path.join(__dirname, '../supabase/migrations/20261123161848_apple_store_notifications_refunds.sql'),
  'utf8',
);
const reversalMigration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261123165000_apple_refund_reversal_reconciliation.sql'), 'utf8');
const orderingMigration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261123173000_apple_notification_signed_date_ordering.sql'), 'utf8');
const index = fs.readFileSync(path.join(__dirname, '../src/index.js'), 'utf8');

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
  assert.match(route, /process\.env\.NODE_ENV !== 'production'[\s\S]*APPLE_IAP_ALLOW_SANDBOX === 'true'/);
  assert.match(route, /rpc\('fulfill_live_spark_purchase'/);
  assert.match(route, /transactionKey = 'apple:' \+ sha256Hex/);
  assert.match(route, /ensureLivePurchaseReceipt/);
  assert.match(migration, /v_purchase\.provider NOT IN \('paystack', 'google_play', 'apple_iap'\)/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.fulfill_live_spark_purchase[\s\S]*TO service_role/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.fulfill_live_spark_purchase[\s\S]*FROM PUBLIC, anon, authenticated/);
});

test('Apple App Store Server Notifications V2 are verified and idempotently reconciled', () => {
  assert.match(notifications, /verifyNotification\(signedPayload\)/);
  assert.match(notifications, /signedTransactionInfo/);
  assert.match(notifications, /verifyTransaction\(signedTransaction\)/);
  assert.match(notifications, /notificationUUID/);
  assert.match(notifications, /record_live_apple_refund/);
  assert.match(notifications, /REFUND.*REVOKE|REFUND' \|\| notificationType === 'REVOKE/);
  assert.match(index, /app\.use\(express\.json[\s\S]*app\.use\('\/webhooks\/apple\/app-store-server', appleStoreNotificationsRouter\)/);
  assert.match(refundMigration, /notification_uuid text NOT NULL UNIQUE/);
  assert.match(refundMigration, /record_live_apple_refund/);
  assert.match(refundMigration, /'apple_iap_risk'/);
  assert.match(refundMigration, /'apple\.refund'/);
  assert.match(refundMigration, /REVOKE ALL ON FUNCTION public\.record_live_apple_refund[\s\S]*FROM PUBLIC, anon, authenticated/);
});

test('Apple REFUND_REVERSED notifications restore only revoked unspent Sparks', () => {
  assert.match(notifications, /notificationType === 'REFUND_REVERSED'/);
  assert.match(notifications, /transaction\.revocationPercentage != null/);
  assert.match(notifications, /record_live_apple_refund_reversal/);
  assert.match(reversalMigration, /refunded_unspent_sparks bigint NOT NULL DEFAULT 0/);
  assert.match(reversalMigration, /SET remaining_sparks = v_restore/);
  assert.match(reversalMigration, /balance_sparks = balance_sparks \+ v_restore/);
  assert.match(reversalMigration, /IF v_purchase\.status = 'disputed' THEN/);
  assert.match(reversalMigration, /ELSIF v_purchase\.status = 'refunded' THEN/);
  assert.match(reversalMigration, /v_purchase\.verified_at IS NULL/);
  assert.match(reversalMigration, /status = 'paid', risk_held_sparks = 0/);
  assert.match(reversalMigration, /risk_hold_reason = NULL/);
  assert.match(reversalMigration, /'apple\.refund_reversed'/);
  assert.match(reversalMigration, /REVOKE ALL ON FUNCTION public\.record_live_apple_refund_reversal[\s\S]*FROM PUBLIC, anon, authenticated/);
  assert.match(reversalMigration, /GRANT EXECUTE ON FUNCTION public\.record_live_apple_refund_reversal[\s\S]*TO service_role/);
});

test('Apple notification signedDate prevents stale refund events from reversing newer state', () => {
  assert.match(notifications, /notificationSignedDate = Number\(notification\?\.signedDate\)/);
  assert.match(notifications, /p_signed_date: notificationSignedDate/);
  assert.match(notifications, /signed_date: notificationSignedDate/);
  assert.match(orderingMigration, /live_apple_transaction_notification_state/);
  assert.match(orderingMigration, /p_signed_date <= v_last_signed_date/);
  assert.match(orderingMigration, /latest_signed_date = EXCLUDED\.latest_signed_date/);
  assert.match(orderingMigration, /p_notification_type/);
  assert.match(orderingMigration, /REVOKE ALL ON FUNCTION public\.record_live_apple_refund\([\s\S]*FROM PUBLIC, anon, authenticated/);
  assert.match(orderingMigration, /GRANT EXECUTE ON FUNCTION public\.record_live_apple_refund_reversal\([\s\S]*TO service_role/);
});
