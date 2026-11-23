const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  verifyGooglePubSubOidcToken,
  resetGooglePubSubKeyCacheForTests,
} = require('../src/utils/googlePubSubOidc');

function signedToken({ privateKey, kid, claims }) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const unsigned = header + '.' + payload;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), privateKey).toString('base64url');
  return unsigned + '.' + signature;
}

function mockResponse(payload, headers = {}) {
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => headers[name.toLowerCase()] || null },
    json: async () => payload,
  };
}

test('verifies Google Pub/Sub OIDC signature, issuer, audience and publisher service account', async () => {
  resetGooglePubSubKeyCacheForTests();
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = 'google-pubsub-test-key';
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'RS256' };
  const now = 1795430000000;
  const token = signedToken({
    privateKey,
    kid,
    claims: {
      iss: 'https://accounts.google.com',
      aud: 'https://zannychat.example/webhooks/google-play',
      email: 'zannychat-pubsub@zannychat-test.iam.gserviceaccount.com',
      email_verified: true,
      sub: '123456789',
      iat: Math.floor(now / 1000) - 10,
      exp: Math.floor(now / 1000) + 300,
    },
  });
  const result = await verifyGooglePubSubOidcToken(token, {
    audience: 'https://zannychat.example/webhooks/google-play',
    serviceAccountEmail: 'zannychat-pubsub@zannychat-test.iam.gserviceaccount.com',
    now: () => now,
    fetchImpl: async () => mockResponse({ keys: [jwk] }, { 'cache-control': 'public, max-age=300' }),
  });
  assert.equal(result.email, 'zannychat-pubsub@zannychat-test.iam.gserviceaccount.com');
  assert.equal(result.subject, '123456789');
});

test('rejects wrong Google Pub/Sub audience, publisher email, expired token and forged signature', async () => {
  resetGooglePubSubKeyCacheForTests();
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = 'google-pubsub-test-key';
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'RS256' };
  const now = 1795430000000;
  const claims = {
    iss: 'accounts.google.com',
    aud: 'wrong-audience',
    email: 'wrong@zannychat-test.iam.gserviceaccount.com',
    email_verified: true,
    iat: Math.floor(now / 1000) - 10,
    exp: Math.floor(now / 1000) - 1,
  };
  const token = signedToken({ privateKey, kid, claims });
  const options = {
    audience: 'expected-audience',
    serviceAccountEmail: 'zannychat-pubsub@zannychat-test.iam.gserviceaccount.com',
    now: () => now,
    fetchImpl: async () => mockResponse({ keys: [jwk] }),
  };
  await assert.rejects(verifyGooglePubSubOidcToken(token, options), /claims are invalid/);
  const forged = token.slice(0, -4) + 'AAAA';
  await assert.rejects(verifyGooglePubSubOidcToken(forged, options), /signature is invalid/);
});
