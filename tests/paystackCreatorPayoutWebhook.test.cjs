const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const route = fs.readFileSync(
  path.join(__dirname, '../src/routes/paystackCreatorPayoutWebhook.js'),
  'utf8',
);

test('Paystack payout webhook resolves the recipient reserved on the payout record', () => {
  assert.match(route, /beneficiary_id,provider_reference,amount_minor,currency,status,provider/);
  assert.match(route, /from\('live_payout_beneficiaries'\)/);
  assert.match(route, /\.eq\('id', payout\.beneficiary_id\)/);
  assert.match(route, /\.eq\('creator_id', payout\.creator_id\)/);
  assert.match(route, /provider_recipient_code: beneficiary\?\.provider_recipient_code/);
});

test('Paystack payout webhook rejects a verified transfer unless the recipient matches the reservation', () => {
  assert.match(route, /transferMatchesPayout\(transfer,[\s\S]*provider_recipient_code: beneficiary\?\.provider_recipient_code/);
  assert.match(route, /Verified Paystack transfer does not match the reserved payout and beneficiary/);
});
