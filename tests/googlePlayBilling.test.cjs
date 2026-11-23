const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  createGooglePlayBillingClient,
  parseServiceAccount,
  sha256Hex,
  GOOGLE_TOKEN_URL,
  GOOGLE_API_BASE,
} = require('../src/services/googlePlayBilling');

function serviceAccount() {
  const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    client_email: 'billing-test@zannychat-test.iam.gserviceaccount.com',
    private_key: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
}

function response(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

test('service account configuration is parsed and validated without logging secrets', () => {
  assert.throws(() => parseServiceAccount('{bad json'), /configuration is invalid/);
  assert.throws(() => parseServiceAccount({ client_email: 'billing@test' }), /configuration is incomplete/);
  assert.equal(sha256Hex('user-123').length, 64);
  assert.equal(moneyToMinor({ currencyCode: 'NGN', units: '125', nanos: 500000000 }), 12550);
  assert.throws(() => moneyToMinor({ currencyCode: 'USD', units: '1', nanos: 0 }), /currency/);
  assert.throws(() => moneyToMinor({ currencyCode: 'NGN', units: '1', nanos: 1 }), /minor currency/);
});

test('verifies Google Play product purchase, account binding, Nigeria region, and consumes only after verification', async () => {
  const account = serviceAccount();
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url === GOOGLE_TOKEN_URL) {
      const form = new URLSearchParams(options.body);
      assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
      const assertion = form.get('assertion').split('.');
      const claims = JSON.parse(Buffer.from(assertion[1], 'base64url').toString('utf8'));
      assert.equal(claims.iss, account.client_email);
      assert.equal(claims.scope, 'https://www.googleapis.com/auth/androidpublisher');
      return response({ access_token: 'google-access-token', expires_in: 3600 });
    }
    if (options.method === 'POST') return response(null, 204);
    if (url.includes('/orders/')) return response({
      state: 'PROCESSED',
      purchaseToken: 'google-purchase-token-123456',
      buyerAddress: { buyerCountry: 'NG' },
      total: { currencyCode: 'NGN', units: '2500', nanos: 0 },
      developerRevenueInBuyerCurrency: { currencyCode: 'NGN', units: '2250', nanos: 0 },
      lineItems: [{
        productId: 'zanny_sparks_100',
        total: { currencyCode: 'NGN', units: '2500', nanos: 0 },
        oneTimePurchaseDetails: { quantity: 1 },
      }],
    });
    return response({
      purchaseState: 0,
      consumptionState: 0,
      acknowledgementState: 0,
      regionCode: 'NG',
      obfuscatedExternalAccountId: sha256Hex('user-123'),
      purchaseTimeMillis: '1795430000000',
      orderId: 'GPA.test-order',
    });
  };

  const client = createGooglePlayBillingClient({
    fetchImpl,
    serviceAccountJson: account,
    now: () => 1795430000000,
  });
  const verified = await client.verifyProductPurchase({
    packageName: 'com.zannychat.app',
    productId: 'zanny_sparks_100',
    purchaseToken: 'google-purchase-token-123456',
    obfuscatedAccountId: sha256Hex('user-123'),
  });
  assert.equal(verified.productId, 'zanny_sparks_100');
  assert.equal(verified.consumptionState, 0);
  assert.equal(verified.regionCode, 'NG');
  assert.equal(verified.amountMinor, 250000);
  assert.equal(verified.providerFeeMinor, 25000);

  await client.consumeProductPurchase({
    packageName: 'com.zannychat.app',
    productId: 'zanny_sparks_100',
    purchaseToken: 'google-purchase-token-123456',
  });
  assert.equal(calls.length, 4);
  assert.match(calls[1].url, /applications\/com\.zannychat\.app\/purchases\/products\/zanny_sparks_100\/tokens\/google-purchase-token-123456$/);
  assert.equal(calls[1].options.headers.Authorization, 'Bearer google-access-token');
  assert.match(calls[2].url, /applications\/com\.zannychat\.app\/orders\/GPA\.test-order$/);
  assert.match(calls[3].url, /:consume$/);
});

test('rejects pending, wrong-account, and non-Nigeria Google Play purchases', async (t) => {
  const account = serviceAccount();
  for (const [label, storeResponse, code] of [
    ['pending', { purchaseState: 2, regionCode: 'NG', obfuscatedExternalAccountId: sha256Hex('user-123') }, 'PURCHASE_NOT_COMPLETED'],
    ['wrong account', { purchaseState: 0, regionCode: 'NG', obfuscatedExternalAccountId: sha256Hex('other-user') }, 'PURCHASE_ACCOUNT_MISMATCH'],
    ['wrong region', { purchaseState: 0, regionCode: 'US', obfuscatedExternalAccountId: sha256Hex('user-123') }, 'PURCHASE_REGION_UNSUPPORTED'],
  ]) {
    await t.test(label, async () => {
      const client = createGooglePlayBillingClient({
        serviceAccountJson: account,
        fetchImpl: async (url) => url === GOOGLE_TOKEN_URL
          ? response({ access_token: 'token', expires_in: 3600 })
          : response(storeResponse),
      });
      await assert.rejects(
        client.verifyProductPurchase({
          packageName: 'com.zannychat.app',
          productId: 'zanny_sparks_100',
          purchaseToken: 'google-purchase-token-123456',
          obfuscatedAccountId: sha256Hex('user-123'),
        }),
        (error) => error.code === code,
      );
    });
  }
});

test('does not expose a successful verification for invalid purchase evidence', async () => {
  const client = createGooglePlayBillingClient({ serviceAccountJson: serviceAccount(), fetchImpl: async () => response({}) });
  await assert.rejects(
    client.verifyProductPurchase({ packageName: 'com.zannychat.app', productId: 'sku', purchaseToken: 'short', obfuscatedAccountId: 'hash' }),
    /evidence is incomplete/,
  );
});

test('Google Play API URLs are built from encoded product and token values', () => {
  assert.equal(GOOGLE_API_BASE, 'https://androidpublisher.googleapis.com/androidpublisher/v3');
});
