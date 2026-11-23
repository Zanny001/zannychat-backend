const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  validPaystackWebhookSignature,
  validTimestampedSignature,
  validLegacySignature,
} = require('../src/utils/paystackWebhookSignature.cjs');

const body = Buffer.from('{"event":"charge.success","data":{"reference":"zc-test-123"}}');
const webhookSecret = 'whsec_test_secret_value';
const apiSecret = 'sk_test_api_secret';
const now = 1_800_000_000;

function timestampedHeader(timestamp, secret, keyId = 'whk_test_123') {
  const signature = crypto.createHmac('sha512', secret)
    .update(String(timestamp) + '.')
    .update(body)
    .digest('hex');
  return 't=' + timestamp + ',v1=' + keyId + ':' + signature;
}

function legacyHeader(secret) {
  return crypto.createHmac('sha512', secret).update(body).digest('hex');
}

test('validates current timestamped Paystack signatures using the separate webhook secret', () => {
  assert.equal(validTimestampedSignature(body, timestampedHeader(now, webhookSecret), webhookSecret, now), true);
  assert.equal(validPaystackWebhookSignature({
    rawBody: body,
    headers: { 'paystack-signature': timestampedHeader(now, webhookSecret) },
    apiSecret,
    webhookSecret,
    nowSeconds: now,
  }), true);
});

test('accepts any matching v1 signature while rejecting malformed key identifiers', () => {
  const valid = timestampedHeader(now, webhookSecret);
  const header = valid + ',v1=whk_old_key:' + '0'.repeat(128);
  assert.equal(validTimestampedSignature(body, header, webhookSecret, now), true);
  assert.equal(validTimestampedSignature(body, header.replace('whk_test_123', 'bad_key'), webhookSecret, now), false);
});

test('rejects stale, future, malformed and tampered timestamped webhook requests', () => {
  assert.equal(validTimestampedSignature(body, timestampedHeader(now - 301, webhookSecret), webhookSecret, now), false);
  assert.equal(validTimestampedSignature(body, timestampedHeader(now + 301, webhookSecret), webhookSecret, now), false);
  assert.equal(validTimestampedSignature(body, 't=abc,v1=whk_test_123:' + '0'.repeat(128), webhookSecret, now), false);
  assert.equal(validTimestampedSignature(Buffer.from('tampered'), timestampedHeader(now, webhookSecret), webhookSecret, now), false);
  assert.equal(validTimestampedSignature(body, timestampedHeader(now, webhookSecret), 'wrong-secret', now), false);
});

test('supports the legacy x-paystack-signature during Paystack migration', () => {
  assert.equal(validLegacySignature(body, legacyHeader(apiSecret), apiSecret), true);
  assert.equal(validPaystackWebhookSignature({
    rawBody: body,
    headers: { 'x-paystack-signature': legacyHeader(apiSecret) },
    apiSecret,
    webhookSecret,
    nowSeconds: now,
  }), true);
});

test('does not downgrade an invalid v2 header to a valid legacy signature', () => {
  assert.equal(validPaystackWebhookSignature({
    rawBody: body,
    headers: {
      'paystack-signature': 't=' + now + ',v1=whk_test_123:' + '0'.repeat(128),
      'x-paystack-signature': legacyHeader(apiSecret),
    },
    apiSecret,
    webhookSecret,
    nowSeconds: now,
  }), false);
});

test('accepts the overlapping current and previous signing secrets during key rotation', () => {
  const previousSecret = 'whsec_previous_secret';
  const header = timestampedHeader(now, previousSecret, 'whk_previous_456');
  assert.equal(validTimestampedSignature(body, header, [webhookSecret, previousSecret], now), true);
});
