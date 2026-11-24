const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const route = fs.readFileSync(path.join(__dirname, '../src/routes/liveCreatorPayouts.js'), 'utf8');
const webhook = fs.readFileSync(path.join(__dirname, '../src/routes/paystackCreatorPayoutWebhook.js'), 'utf8');
const signatureVerifier = fs.readFileSync(path.join(__dirname, '../src/utils/paystackWebhookSignature.cjs'), 'utf8');
const index = fs.readFileSync(path.join(__dirname, '../src/index.js'), 'utf8');
const migration = fs.readFileSync(
  path.join(__dirname, '../supabase/migrations/20261123190000_live_creator_payout_reservations.sql'),
  'utf8',
);

test('creator payouts require verified identity, verified beneficiary and explicit payout enablement', () => {
  assert.match(route, /LIVE_PAYOUTS_ENABLED === 'true'/);
  assert.match(route, /LIVE_PAYOUTS_TRANSFER_OTP_DISABLED === 'true'/);
  assert.match(route, /LIVE_PAYOUTS_FEE_POLICY_CONFIGURED === 'true'/);
  assert.match(route, /PAYOUT_FEE_POLICY_REQUIRED/);
  assert.match(route, /PAYOUT_TRANSFER_APPROVAL_REQUIRED/);
  assert.match(route, /verificationStatus: profile\?\.verification_status/);
  assert.match(route, /PAYOUT_KYC_REQUIRED/);
  assert.match(migration, /verification_status <> 'verified'/);
  assert.match(migration, /payout_hold/);
  assert.match(migration, /status = 'verified'/);
});

test('bank account details are resolved by Paystack and only masked details plus recipient token are stored', () => {
  assert.match(route, /\/bank\/resolve\?account_number=/);
  assert.match(route, /\/transferrecipient/);
  assert.match(route, /account_last4: accountNumber\.slice\(-4\)/);
  assert.match(route, /provider_recipient_code: recipient\.recipient_code/);
  const persistenceBlock = route.slice(route.indexOf("from('live_payout_beneficiaries')"), route.indexOf(".select('id,bank_code"));
  assert.doesNotMatch(persistenceBlock, /account_number/);
});

test('payout requests reserve only available earnings under a per-creator database lock', () => {
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(migration, /minimum_withdrawal_minor/);
  assert.match(migration, /status IN \('requested', 'processing', 'paid'\)/);
  assert.match(migration, /insufficient available creator earnings/);
  assert.match(route, /rpc\('request_live_creator_payout'/);
  assert.match(route, /status: 'processing'/);
  assert.match(route, /reconciliationPending: true/);
});

test('transfer webhooks authenticate raw bytes and independently verify provider transfer state', () => {
  assert.match(webhook, /express\.raw\(\{ type: 'application\/json'/);
  assert.match(webhook, /validPaystackWebhookSignature/);
  assert.match(signatureVerifier, /PAYSTACK_WEBHOOK_SECRET/);
  assert.match(signatureVerifier, /PAYSTACK_WEBHOOK_SECRET_PREVIOUS/);
  assert.match(webhook, /\/transfer\/verify\//);
  assert.match(webhook, /transferMatchesPayout\(transfer,\s*\{/);
  assert.match(webhook, /beneficiary_id,provider_reference,amount_minor,currency,status,provider/);\n  assert.match(webhook, /provider_recipient_code: beneficiary\?\.provider_recipient_code/);\n  assert.match(webhook, /from\('live_payout_beneficiaries'\)/);
  assert.match(webhook, /Verified Paystack transfer does not match the reserved payout and beneficiary/);
  assert.match(webhook, /transfer\.success/);
  assert.match(webhook, /transfer\.failed/);
  assert.match(webhook, /transfer\.reversed/);
  assert.match(index, /app\.use\('\/webhooks\/paystack\/live-payouts', paystackCreatorPayoutWebhookRouter\)/);
  assert.match(index, /app\.use\('\/live\/creator-payouts', liveCreatorPayoutsRouter\)/);
});

test('withdrawal reservation first releases earnings whose clearance period has elapsed', () => {
  assert.match(migration, /SET status = 'available'/);
  assert.match(migration, /status = 'pending' AND available_at IS NOT NULL AND available_at <= now\(\)/);
});
