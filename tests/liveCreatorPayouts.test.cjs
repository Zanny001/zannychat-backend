const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const route = fs.readFileSync(path.join(__dirname, '../src/routes/liveCreatorPayouts.js'), 'utf8');
const webhook = fs.readFileSync(path.join(__dirname, '../src/routes/paystackCreatorPayoutWebhook.js'), 'utf8');
const index = fs.readFileSync(path.join(__dirname, '../src/index.js'), 'utf8');
const migration = fs.readFileSync(
  path.join(__dirname, '../supabase/migrations/20261123190000_live_creator_payout_reservations.sql'),
  'utf8',
);

test('creator payouts require verified identity, verified beneficiary and explicit payout enablement', () => {
  assert.match(route, /LIVE_PAYOUTS_ENABLED === 'true'/);
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
  assert.doesNotMatch(route, /account_number:\s*accountNumber\s*[,}]/);
  assert.doesNotMatch(route, /account_number:\s*req\.body/);
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
  assert.match(webhook, /createHmac\('sha512'/);
  assert.match(webhook, /timingSafeEqual/);
  assert.match(webhook, /\/transfer\/verify\//);
  assert.match(webhook, /transfer\.success/);
  assert.match(webhook, /transfer\.failed/);
  assert.match(webhook, /transfer\.reversed/);
  assert.match(index, /app\.use\('\/webhooks\/paystack\/live-payouts', paystackCreatorPayoutWebhookRouter\)/);
  assert.match(index, /app\.use\('\/live\/creator-payouts', liveCreatorPayoutsRouter\)/);
});
