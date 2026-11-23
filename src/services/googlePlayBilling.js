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
    return {
      productId,
      purchaseToken,
      purchaseTimeMillis: String(purchase.purchaseTimeMillis || ''),
      orderId: typeof purchase.orderId === 'string' ? purchase.orderId : null,
      consumptionState: Number(purchase.consumptionState),
      acknowledgementState: Number(purchase.acknowledgementState),
      regionCode: purchase.regionCode,
    };
  }

  async function consumeProductPurchase({ packageName, productId, purchaseToken }) {
    const url = GOOGLE_API_BASE + '/applications/' + encodeURIComponent(packageName)
      + '/purchases/products/' + encodeURIComponent(productId)
      + '/tokens/' + encodeURIComponent(purchaseToken) + ':consume';
    await googleRequest(url, { method: 'POST' });
    return { consumed: true };
  }

  return { verifyProductPurchase, consumeProductPurchase };
}

module.exports = {
  createGooglePlayBillingClient,
  parseServiceAccount,
  sha256Hex,
  GOOGLE_PLAY_SCOPE,
  GOOGLE_TOKEN_URL,
  GOOGLE_API_BASE,
};
