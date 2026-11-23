const crypto = require('node:crypto');

const GOOGLE_PLAY_SCOPE = 'https://www.googleapis.com/auth/androidpublisher';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_API_BASE = 'https://androidpublisher.googleapis.com/androidpublisher/v3';
const DEFAULT_TIMEOUT_MS = 12000;

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function moneyToMinor(money, expectedCurrency = 'NGN') {
  if (!money || money.currencyCode !== expectedCurrency) {
    throw new Error('Google Play order currency does not match the configured Sparks package');
  }
  let units;
  let nanos;
  try {
    units = BigInt(money.units || '0');
    nanos = BigInt(money.nanos || 0);
  } catch (_) {
    throw new Error('Google Play order amount is invalid');
  }
  if (units < 0n || nanos < 0n || nanos >= 1000000000n || nanos % 10000000n !== 0n) {
    throw new Error('Google Play order amount cannot be represented in minor currency units');
  }
  const minor = units * 100n + nanos / 10000000n;
  const value = Number(minor);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('Google Play order amount is outside the supported range');
  }
  return value;
}

function parseServiceAccount(value) {
  let account;
  try {
    account = typeof value === 'string' ? JSON.parse(value) : value;
  } catch (_) {
    throw new Error('Google Play service account configuration is invalid');
  }
  if (!account || typeof account.client_email !== 'string'
      || typeof account.private_key !== 'string'
      || !account.private_key.includes('PRIVATE KEY')) {
    throw new Error('Google Play service account configuration is incomplete');
  }
  return account;
}

function createGooglePlayBillingClient({
  fetchImpl = fetch,
  serviceAccountJson = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON,
  now = () => Date.now(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  let cachedAccessToken = null;
  let cachedAccessTokenExpiresAt = 0;

  async function getAccessToken() {
    if (cachedAccessToken && cachedAccessTokenExpiresAt > now() + 60000) {
      return cachedAccessToken;
    }
    const account = parseServiceAccount(serviceAccountJson);
    const issuedAt = Math.floor(now() / 1000);
    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = base64url(JSON.stringify({
      iss: account.client_email,
      scope: GOOGLE_PLAY_SCOPE,
      aud: GOOGLE_TOKEN_URL,
      iat: issuedAt,
      exp: issuedAt + 3600,
    }));
    const unsigned = header + '.' + claims;
    const signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), account.private_key).toString('base64url');
    const assertion = unsigned + '.' + signature;
    const response = await fetchImpl(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }).toString(),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const payload = await response.json();
    if (!response.ok || typeof payload?.access_token !== 'string'
        || !Number.isFinite(Number(payload.expires_in))) {
      throw new Error('Google Play authorization could not be established');
    }
    cachedAccessToken = payload.access_token;
    cachedAccessTokenExpiresAt = now() + Number(payload.expires_in) * 1000;
    return cachedAccessToken;
  }

  async function googleRequest(url, options = {}) {
    const accessToken = await getAccessToken();
    const response = await fetchImpl(url, {
      ...options,
      headers: { ...(options.headers || {}), Authorization: 'Bearer ' + accessToken },
      signal: options.signal || AbortSignal.timeout(timeoutMs),
    });
    const payload = response.status === 204 ? null : await response.json();
    if (!response.ok) {
      const error = new Error('Google Play purchase verification is temporarily unavailable');
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  async function verifyProductPurchase({ packageName, productId, purchaseToken, obfuscatedAccountId }) {
    if (!packageName || !productId || typeof purchaseToken !== 'string'
        || purchaseToken.length < 16 || purchaseToken.length > 4096
        || !obfuscatedAccountId) {
      throw new Error('Google Play purchase evidence is incomplete');
    }
    const url = GOOGLE_API_BASE + '/applications/' + encodeURIComponent(packageName)
      + '/purchases/products/' + encodeURIComponent(productId)
      + '/tokens/' + encodeURIComponent(purchaseToken);
    const purchase = await googleRequest(url);
    if (purchase?.purchaseState !== 0) {
      const error = new Error('Google Play has not confirmed a completed purchase');
      error.code = 'PURCHASE_NOT_COMPLETED';
      throw error;
    }
    if (purchase?.obfuscatedExternalAccountId !== obfuscatedAccountId) {
      const error = new Error('Google Play purchase is not linked to this ZannyChat account');
      error.code = 'PURCHASE_ACCOUNT_MISMATCH';
      throw error;
    }
    if (purchase?.regionCode !== 'NG') {
      const error = new Error('This Sparks package is currently available only to the Nigerian Play Store region');
      error.code = 'PURCHASE_REGION_UNSUPPORTED';
      throw error;
    }
    if (process.env.NODE_ENV === 'production' && purchase?.purchaseType === 0) {
      const error = new Error('Google Play test purchases cannot credit production Sparks');
      error.code = 'TEST_PURCHASE_NOT_ALLOWED';
      throw error;
    }
    if (purchase?.quantity !== undefined && Number(purchase.quantity) !== 1) {
      throw new Error('Only single-quantity Sparks purchases are supported');
    }
    if (typeof purchase.orderId !== 'string' || !purchase.orderId) {
      throw new Error('Google Play did not provide a verifiable order identifier');
    }

    const orderUrl = GOOGLE_API_BASE + '/applications/' + encodeURIComponent(packageName)
      + '/orders/' + encodeURIComponent(purchase.orderId);
    const order = await googleRequest(orderUrl);
    if (order?.state !== 'PROCESSED' || order?.purchaseToken !== purchaseToken
        || order?.buyerAddress?.buyerCountry !== 'NG'
        || !Array.isArray(order?.lineItems) || order.lineItems.length !== 1
        || order.lineItems[0]?.productId !== productId
        || Number(order.lineItems[0]?.oneTimePurchaseDetails?.quantity || 1) !== 1) {
      throw new Error('Google Play order does not match a completed single Sparks purchase for Nigeria');
    }
    const amountMinor = moneyToMinor(order.total, 'NGN');
    const lineItemAmountMinor = moneyToMinor(order.lineItems[0].total, 'NGN');
    if (lineItemAmountMinor !== amountMinor) {
      throw new Error('Google Play order total does not match its Sparks product line item');
    }
    const developerRevenueMinor = moneyToMinor(order.developerRevenueInBuyerCurrency, 'NGN');
    if (developerRevenueMinor > amountMinor) {
      throw new Error('Google Play developer proceeds exceed the verified order total');
    }
    const providerFeeMinor = amountMinor - developerRevenueMinor;
    return {
      productId,
      purchaseToken,
      purchaseTimeMillis: String(purchase.purchaseTimeMillis || ''),
      orderId: purchase.orderId,
      consumptionState: Number(purchase.consumptionState),
      acknowledgementState: Number(purchase.acknowledgementState),
      regionCode: purchase.regionCode,
      amountMinor,
      providerFeeMinor,
      currency: 'NGN',
    };
  }

  async function verifyVoidedPurchase({ packageName, purchaseToken, orderId, voidedTimeMillis, refundType }) {
    if (!packageName || typeof purchaseToken !== 'string' || purchaseToken.length < 16
        || purchaseToken.length > 4096 || typeof orderId !== 'string' || !orderId) {
      throw new Error('Google Play voided purchase evidence is incomplete');
    }
    const normalizedRefundType = Number(refundType);
    if (![1, 2].includes(normalizedRefundType)) {
      throw new Error('Google Play voided notification has an unsupported refund type');
    }
    const eventTime = Number(voidedTimeMillis);
    const endTime = now();
    const startTime = Number.isFinite(eventTime) && eventTime > 0
      ? Math.max(0, eventTime - 24 * 60 * 60 * 1000)
      : Math.max(0, endTime - 30 * 24 * 60 * 60 * 1000);
    let pageToken = null;
    for (let page = 0; page < 10; page += 1) {
      const params = new URLSearchParams({
        type: '0',
        maxResults: '1000',
        startTime: String(startTime),
        endTime: String(endTime),
        includeQuantityBasedPartialRefund: 'true',
      });
      if (pageToken) params.set('token', pageToken);
      const url = GOOGLE_API_BASE + '/applications/' + encodeURIComponent(packageName)
        + '/purchases/voidedpurchases?' + params.toString();
      const payload = await googleRequest(url);
      const purchases = Array.isArray(payload?.voidedPurchases) ? payload.voidedPurchases : [];
      const match = purchases.find((item) =>
        String(item.purchaseToken || '') === purchaseToken
        && String(item.orderId || '') === orderId
      );
      if (match) {
        return {
          purchaseToken,
          orderId,
          voidedTimeMillis: String(match.voidedTimeMillis || voidedTimeMillis || ''),
          refundType: normalizedRefundType,
          voidedQuantity: Number.isSafeInteger(Number(match.voidedQuantity))
            ? Number(match.voidedQuantity) : null,
          voidedSource: Number(match.voidedSource),
          voidedReason: Number(match.voidedReason),
        };
      }
      pageToken = payload?.tokenPagination?.nextPageToken || payload?.nextPageToken || null;
      if (!pageToken) break;
    }
    throw new Error('Google Play Voided Purchases API did not confirm this notification');
  }

  async function consumeProductPurchase({ packageName, productId, purchaseToken }) {
    const url = GOOGLE_API_BASE + '/applications/' + encodeURIComponent(packageName)
      + '/purchases/products/' + encodeURIComponent(productId)
      + '/tokens/' + encodeURIComponent(purchaseToken) + ':consume';
    await googleRequest(url, { method: 'POST' });
    return { consumed: true };
  }

  return { verifyProductPurchase, verifyVoidedPurchase, consumeProductPurchase };
}

module.exports = {
  createGooglePlayBillingClient,
  parseServiceAccount,
  sha256Hex,
  moneyToMinor,
  GOOGLE_PLAY_SCOPE,
  GOOGLE_TOKEN_URL,
  GOOGLE_API_BASE,
};
