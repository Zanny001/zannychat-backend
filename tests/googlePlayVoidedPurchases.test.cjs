const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  createGooglePlayBillingClient,
  GOOGLE_TOKEN_URL,
} = require('../src/services/googlePlayBilling');

function serviceAccount() {
  const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    client_email: 'billing-test@zannychat-test.iam.gserviceaccount.com',
    private_key: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
}

function response(payload) {
  return { ok: true, status: 200, json: async () => payload };
}

test('verifies one-time Google Play void notifications against the authoritative Voided Purchases API', async () => {
  const calls = [];
  const client = createGooglePlayBillingClient({
    serviceAccountJson: serviceAccount(),
    now: () => 1795430000000,
    fetchImpl: async (url) => {
      calls.push(url);
      if (url === GOOGLE_TOKEN_URL) return response({ access_token: 'google-access-token', expires_in: 3600 });
      const parsed = new URL(url);
      assert.match(parsed.pathname, /purchases\/voidedpurchases$/);
      assert.equal(parsed.searchParams.get('type'), '0');
      assert.equal(parsed.searchParams.get('maxResults'), '1000');
      assert.equal(parsed.searchParams.get('includeQuantityBasedPartialRefund'), 'true');
      return response({
        voidedPurchases: [{
          purchaseToken: 'google-purchase-token-123456',
          orderId: 'GPA.test-order',
          productType: 2,
          refundType: 1,
          voidedTimeMillis: '1795429900000',
          voidedSource: 0,
          voidedReason: 1,
        }],
      });
    },
  });
  const verified = await client.verifyVoidedPurchase({
    packageName: 'com.zannychat.app',
    purchaseToken: 'google-purchase-token-123456',
    orderId: 'GPA.test-order',
    voidedTimeMillis: '1795429900000',
  });
  assert.equal(verified.refundType, 1);
  assert.equal(verified.orderId, 'GPA.test-order');
  assert.equal(calls.length, 2);
});

test('does not accept a voided notification for another token, order or subscription', async () => {
  const client = createGooglePlayBillingClient({
    serviceAccountJson: serviceAccount(),
    fetchImpl: async (url) => url === GOOGLE_TOKEN_URL
      ? response({ access_token: 'google-access-token', expires_in: 3600 })
      : response({
        voidedPurchases: [{
          purchaseToken: 'different-token-123456',
          orderId: 'GPA.other-order',
          productType: 1,
          refundType: 1,
        }],
      }),
  });
  await assert.rejects(client.verifyVoidedPurchase({
    packageName: 'com.zannychat.app',
    purchaseToken: 'google-purchase-token-123456',
    orderId: 'GPA.test-order',
    voidedTimeMillis: '1795429900000',
  }), /did not confirm this notification/);
});
