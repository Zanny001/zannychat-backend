const test = require('node:test');
const assert = require('node:assert/strict');
const { deleteLiveKitRoom } = require('../src/services/livekitRoomAdmin');

test('LIVE room names can be safely deleted through LiveKit RoomService', async () => {
  let request;
  const result = await deleteLiveKitRoom('zlive_0123456789abcdef0123456789abcdef', {
    config: { url: 'wss://example.livekit.cloud', apiKey: 'test-key', apiSecret: 'test-secret' },
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, status: 200, text: async () => '' };
    },
    nowSeconds: 1_800_000_000,
  });
  assert.deepEqual(result, { deleted: true, alreadyAbsent: false });
  assert.equal(request.url, 'https://example.livekit.cloud/twirp/livekit.RoomService/DeleteRoom');
  assert.equal(JSON.parse(request.options.body).room, 'zlive_0123456789abcdef0123456789abcdef');
});

test('LIVE room deletion treats an already absent room as successfully cleaned', async () => {
  const result = await deleteLiveKitRoom('zlive_0123456789abcdef0123456789abcdef', {
    config: { url: 'wss://example.livekit.cloud', apiKey: 'test-key', apiSecret: 'test-secret' },
    fetchImpl: async () => ({ ok: false, status: 404, text: async () => '' }),
    nowSeconds: 1_800_000_000,
  });
  assert.deepEqual(result, { deleted: true, alreadyAbsent: true });
});

test('LIVE room deletion rejects room names outside the generated ZannyChat namespace', async () => {
  await assert.rejects(
    deleteLiveKitRoom('attacker-controlled-room', {
      config: { url: 'wss://example.livekit.cloud', apiKey: 'test-key', apiSecret: 'test-secret' },
      fetchImpl: async () => ({ ok: true, status: 200 }),
    }),
    /Invalid ZannyChat LiveKit room name/,
  );
});
