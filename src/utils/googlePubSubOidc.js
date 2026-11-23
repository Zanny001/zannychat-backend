const crypto = require('node:crypto');

const GOOGLE_CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
let cachedKeys = null;
let cachedKeysExpiresAt = 0;

function decodeJwtPart(value) {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
}

async function getGoogleSigningKeys({ fetchImpl = fetch, now = () => Date.now() } = {}) {
  if (cachedKeys && cachedKeysExpiresAt > now()) return cachedKeys;
  const response = await fetchImpl(GOOGLE_CERTS_URL, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error('Google Pub/Sub signing keys are unavailable');
  const payload = await response.json();
  if (!Array.isArray(payload?.keys) || payload.keys.length === 0) {
    throw new Error('Google Pub/Sub signing key response is invalid');
  }
  const cacheControl = response.headers?.get?.('cache-control') || '';
  const maxAge = Number(cacheControl.match(/max-age=(\d+)/i)?.[1] || 300);
  cachedKeys = payload.keys;
  cachedKeysExpiresAt = now() + Math.max(30, Math.min(maxAge, 3600)) * 1000;
  return cachedKeys;
}

async function verifyGooglePubSubOidcToken(token, {
  audience,
  serviceAccountEmail,
  fetchImpl = fetch,
  now = () => Date.now(),
} = {}) {
  if (typeof token !== 'string' || token.length < 32 || token.length > 8192
      || typeof audience !== 'string' || !audience
      || typeof serviceAccountEmail !== 'string' || !serviceAccountEmail) {
    throw new Error('Google Pub/Sub authentication configuration is incomplete');
  }
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Google Pub/Sub identity token is malformed');
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = decodeJwtPart(encodedHeader);
  const claims = decodeJwtPart(encodedPayload);
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') {
    throw new Error('Google Pub/Sub identity token uses an unsupported signing key');
  }
  const keys = await getGoogleSigningKeys({ fetchImpl, now });
  const jwk = keys.find((key) => key.kid === header.kid && key.kty === 'RSA' && key.use === 'sig');
  if (!jwk) throw new Error('Google Pub/Sub signing key was not found');

  const publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const signature = Buffer.from(encodedSignature, 'base64url');
  const validSignature = crypto.verify(
    'RSA-SHA256',
    Buffer.from(encodedHeader + '.' + encodedPayload),
    publicKey,
    signature,
  );
  if (!validSignature) throw new Error('Google Pub/Sub identity token signature is invalid');

  const currentSeconds = Math.floor(now() / 1000);
  const validIssuer = claims.iss === 'https://accounts.google.com' || claims.iss === 'accounts.google.com';
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!validIssuer || !audiences.includes(audience)
      || claims.email !== serviceAccountEmail || claims.email_verified !== true
      || !Number.isFinite(Number(claims.exp)) || Number(claims.exp) <= currentSeconds
      || !Number.isFinite(Number(claims.iat)) || Number(claims.iat) > currentSeconds + 60) {
    throw new Error('Google Pub/Sub identity token claims are invalid');
  }
  return { email: claims.email, subject: String(claims.sub || ''), expiresAt: Number(claims.exp) };
}

function resetGooglePubSubKeyCacheForTests() {
  cachedKeys = null;
  cachedKeysExpiresAt = 0;
}

module.exports = {
  GOOGLE_CERTS_URL,
  verifyGooglePubSubOidcToken,
  resetGooglePubSubKeyCacheForTests,
};
