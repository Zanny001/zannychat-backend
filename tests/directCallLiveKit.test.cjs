const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHmac } = require('node:crypto');
const { createLiveKitToken, getLiveKitConfig } = require('../src/services/livekitToken');

const route = fs.readFileSync(path.join(__dirname, '../src/routes/calls.js'), 'utf8');

test('direct-call LiveKit token is signed, short-lived, and scoped to the deterministic direct room', () => {
  const config = { url: 'wss://media.example.invalid', apiKey: 'key-1', apiSecret: 'secret-1' };
  const callId = '12345678-1234-4234-8234-123456789abc';
  const room = 'zdc_' + callId.replace(/-/g, '');
  const token = createLiveKitToken({
    identity: 'participant-1',
    name: 'Participant',
    room,
    canPublish: true,
    canSubscribe: true,
    canPublishData: false,
    ttlSeconds: 900,
    nowSeconds: 1_800_000_000,
    config,
  });
  const [header, payload, signature] = token.split('.');
  const expected = createHmac('sha256', config.apiSecret).update(header + '.' + payload).digest('base64url');
  assert.equal(signature, expected);
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  assert.equal(claims.sub, 'participant-1');
  assert.equal(claims.exp - claims.nbf, 905);
  assert.deepEqual(claims.video, {
    roomJoin: true, room, canPublish: true, canSubscribe: true, canPublishData: false,
  });
});

test('direct-call LiveKit route requires an authenticated active participant and accepted call', () => {
  assert.ok(route.includes("router.use(requireAuth"));
  assert.ok(route.includes("router.post('/:callId/livekit-token'"));
  assert.ok(route.includes(".from('call_sessions')"));
  assert.ok(route.includes("[call.caller_id, call.callee_id].includes(req.user.id)"));
  assert.ok(route.includes("call.status !== 'accepted'"));
  assert.ok(route.includes('call.group_room_id'));
  assert.ok(route.includes("router.post('/:callId/livekit-token'"));
});

test('direct-call LiveKit route denies blocked peers, stale sessions, and data-channel publishing', () => {
  assert.ok(route.includes(".from('blocked_users')"));
  assert.ok(route.includes('3 * 60 * 1000'));
  assert.ok(route.includes('canPublishData: false'));
  assert.ok(route.includes('ttlSeconds: 900'));
  assert.ok(route.includes("res.set('Cache-Control', 'no-store')"));
});

test('direct-call LiveKit configuration fails closed when server credentials are incomplete', () => {
  assert.equal(getLiveKitConfig({
    LIVEKIT_URL: 'wss://media.example.invalid',
    LIVEKIT_API_KEY: 'key-only',
  }), null);
});
