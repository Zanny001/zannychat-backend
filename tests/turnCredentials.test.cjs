const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { buildIceConfig } = require('../src/utils/turnCredentials.cjs');

const secret = 'z'.repeat(40);

test('TURN credentials are time-limited and cryptographically bound to the user', () => {
  const config = buildIceConfig({ userId: 'user-123', urls: ['turn:turn.example.com:3478', 'turns:turn.example.com:5349'], secret, ttlSeconds: 600, nowSeconds: 1000 });
  assert.equal(config.turnConfigured, true);
  const turn = config.iceServers.find((server) => server.username);
  assert.equal(turn.username, '1600:user-123');
  assert.equal(turn.credential, crypto.createHmac('sha1', secret).update('1600:user-123').digest('base64'));
  assert.deepEqual(turn.urls, ['turn:turn.example.com:3478', 'turns:turn.example.com:5349']);
  assert.equal(config.credentialExpiresAt, new Date(1600 * 1000).toISOString());
  assert.equal(JSON.stringify(config).includes(secret), false);
});

test('TURN credentials fail closed to STUN when the secret or URL is invalid', () => {
  const missingSecret = buildIceConfig({ userId: 'user-123', urls: ['turn:turn.example.com:3478'], secret: 'short', nowSeconds: 1000 });
  assert.equal(missingSecret.turnConfigured, false);
  assert.equal(missingSecret.iceServers.some((server) => server.username), false);
  const invalidUrl = buildIceConfig({ userId: 'user-123', urls: ['https://turn.example.com'], secret, nowSeconds: 1000 });
  assert.equal(invalidUrl.turnConfigured, false);
});

test('TURN credential TTL is bounded between five minutes and one hour', () => {
  const low = buildIceConfig({ userId: 'u', urls: ['turn:relay.example:3478'], secret, ttlSeconds: 1, nowSeconds: 1000 });
  assert.equal(low.iceServers.find((server) => server.username).username, '1300:u');
  const high = buildIceConfig({ userId: 'u', urls: ['turn:relay.example:3478'], secret, ttlSeconds: 99999, nowSeconds: 1000 });
  assert.equal(high.iceServers.find((server) => server.username).username, '4600:u');
});
