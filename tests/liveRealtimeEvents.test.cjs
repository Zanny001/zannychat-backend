const test = require('node:test');
const assert = require('node:assert/strict');
const {
  sendRoomData,
  createRoomAdminToken,
  roomServiceUrl,
} = require('../src/services/livekitRoomAdmin');

const config = {
  url: 'wss://zanny.livekit.cloud',
  apiKey: 'test-key',
  apiSecret: 'test-secret',
};
const room = 'zlive_0123456789abcdef0123456789abcdef';

test('LIVE server room events use a room-scoped admin token and reliable private topic', async () => {
  let request;
  const result = await sendRoomData(room, { v: 1, type: 'feed_changed' }, config, async (url, options) => {
    request = { url, options };
    return { ok: true, status: 200, json: async () => ({}) };
  });

  assert.deepEqual(result, {});
  assert.equal(request.url, roomServiceUrl(config.url, 'SendData'));
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers['Content-Type'], 'application/json');
  const body = JSON.parse(request.options.body);
  assert.equal(body.room, room);
  assert.equal(body.kind, 'RELIABLE');
  assert.equal(body.topic, 'zanny.live.feed.v1');
  assert.deepEqual(JSON.parse(Buffer.from(body.data, 'base64').toString('utf8')), {
    v: 1,
    type: 'feed_changed',
  });
  const token = request.options.headers.Authorization.slice('Bearer '.length);
  const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
  assert.equal(claims.video.room, room);
  assert.equal(claims.video.roomAdmin, true);
  assert.equal(claims.exp - claims.nbf, 65);
});

test('LIVE room data only permits valid room names and bounded object payloads', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({}) });
  await assert.rejects(sendRoomData('untrusted-room', { v: 1 }, config, fetchImpl), /Invalid ZannyChat LiveKit room name/);
  await assert.rejects(sendRoomData(room, 'not-an-object', config, fetchImpl), /valid LIVE room event/);
  await assert.rejects(sendRoomData(room, { text: 'x'.repeat(600) }, config, fetchImpl), /payload limit/);
});

test('LIVE comment and reaction events are emitted only after durable server-side writes', () => {
  const fs = require('node:fs');
  const route = fs.readFileSync(require.resolve('../src/routes/liveStreams'), 'utf8');
  const commentWrite = route.indexOf(".from('live_stream_comments').insert({");
  const commentSignal = route.indexOf('publishLiveFeedChanged(stream);', commentWrite);
  const reactionWrite = route.indexOf("rpc('record_live_creator_impact'");
  const reactionSignal = route.indexOf('publishLiveFeedChanged(stream);', reactionWrite);
  assert.ok(commentWrite >= 0 && commentSignal > commentWrite);
  assert.ok(reactionWrite >= 0 && reactionSignal > reactionWrite);
  assert.match(route, /canPublishData:\s*false/);
  assert.match(route, /type:\s*'feed_changed'/);
});


test('hiding a LIVE comment broadcasts a server-authoritative feed invalidation', () => {
  const hideRoute = route.slice(route.indexOf("router.post('/:streamId/comments/:commentId/hide'"));
  assert.match(hideRoute, /moderation_status: 'hidden'[\s\S]*?publishLiveFeedChanged\(stream\)/);
});

test('LIVE room data rejects unapproved event types and extra fields', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({}) });
  await assert.rejects(sendRoomData(room, { v: 1, type: 'guest_private_request', userId: 'private-user' }, config, fetchImpl), /Unsupported LIVE room event/);
  await assert.rejects(sendRoomData(room, { v: 1, type: 'feed_changed', userId: 'private-user' }, config, fetchImpl), /Unsupported LIVE room event/);
  await assert.rejects(sendRoomData(room, { v: 2, type: 'feed_changed' }, config, fetchImpl), /Unsupported LIVE room event/);
});
