const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHmac } = require('node:crypto');
const { createLiveKitToken, getLiveKitConfig } = require('../src/services/livekitToken');

const route = fs.readFileSync(path.join(__dirname, '../src/routes/groupCalls.js'), 'utf8');
const migration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261110065856_group_call_rooms.sql'), 'utf8');
const pushClient = fs.readFileSync(path.join(__dirname, '../src/config/pushClient.js'), 'utf8');

test('LiveKit access tokens are short-lived, room-scoped, and signed with the server secret', () => {
  const config = { url: 'wss://media.example.invalid', apiKey: 'key-1', apiSecret: 'secret-1' };
  const token = createLiveKitToken({
    identity: 'user-1', name: 'Member', room: 'zgc-room-1',
    canPublish: true, canSubscribe: true, nowSeconds: 1_800_000_000, config,
  });
  const [header, payload, signature] = token.split('.');
  const expected = createHmac('sha256', config.apiSecret).update(header + '.' + payload).digest('base64url');
  assert.equal(signature, expected);
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  assert.equal(claims.iss, 'key-1');
  assert.equal(claims.sub, 'user-1');
  assert.equal(claims.exp - claims.nbf, 3605);
  assert.deepEqual(claims.video, {
    roomJoin: true, room: 'zgc-room-1', canPublish: true,
    canSubscribe: true, canPublishData: true,
  });
});

test('LiveKit is fail-closed when server credentials are missing', () => {
  assert.equal(getLiveKitConfig({ LIVEKIT_URL: 'wss://media.invalid', LIVEKIT_API_KEY: 'key' }), null);
  assert.throws(() => createLiveKitToken({ identity: 'u', room: 'r', config: null }), /not configured/);
});

test('group call endpoints require authenticated group membership and enforce host/admin termination', () => {
  assert.ok(route.includes('router.use(requireAuth'));
  assert.ok(route.includes(".from('conversations').select('id,is_group,name')"));
  assert.ok(route.includes('!conversation.is_group'));
  assert.ok(route.includes(".from('conversation_participants')"));
  assert.ok(route.includes('room.host_user_id !== req.user.id && !group.membership.is_admin'));
  assert.ok(route.includes('This group call is full'));
  assert.ok(route.includes("type: 'group_call_invite'"));
  assert.ok(route.includes('sendPushToUser'));
  assert.ok(pushClient.includes("['incoming_call', 'group_call_invite'].includes(data?.type)"));
});

test('group call database state is backend-only and limits active rooms per group', () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.group_call_rooms/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.group_call_participants/);
  assert.match(migration, /group_call_one_active_room_per_conversation/);
  assert.match(migration, /max_participants BETWEEN 2 AND 16/);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /REVOKE ALL ON public\.group_call_rooms, public\.group_call_participants FROM PUBLIC, anon, authenticated/);
  assert.match(migration, /GRANT ALL ON public\.group_call_rooms, public\.group_call_participants TO service_role/);
});
