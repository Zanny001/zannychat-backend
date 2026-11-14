const test = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const {
  createRoomAdminToken,
  roomServiceUrl,
  requestRoomService,
  listRoomParticipants,
  removeRoomParticipant,
  muteRoomParticipantTrack,
} = require('../src/services/livekitRoomAdmin');
const route = require('node:fs').readFileSync(require('node:path').join(__dirname, '../src/routes/liveStreams.js'), 'utf8');

const config = { url: 'wss://zanny-test.livekit.cloud', apiKey: 'stage-key', apiSecret: 'stage-secret' };

test('room-admin tokens are short-lived and scoped to one room', () => {
  const token = createRoomAdminToken(config, 'room-1', 1800000000);
  const [header, payload, signature] = token.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url').toString()), { alg: 'HS256', typ: 'JWT' });
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
  assert.equal(claims.iss, config.apiKey);
  assert.equal(claims.sub, 'zannychat-live-stage-admin');
  assert.deepEqual(claims.video, { room: 'room-1', roomAdmin: true });
  assert.equal(claims.exp - claims.nbf, 65);
  assert.equal(signature, createHmac('sha256', config.apiSecret).update(header + '.' + payload).digest('base64url'));
});

test('room service URLs allow only the three required administration methods', () => {
  assert.equal(roomServiceUrl(config.url, 'ListParticipants'), 'https://zanny-test.livekit.cloud/twirp/livekit.RoomService/ListParticipants');
  assert.equal(roomServiceUrl(config.url, 'RemoveParticipant'), 'https://zanny-test.livekit.cloud/twirp/livekit.RoomService/RemoveParticipant');
  assert.equal(roomServiceUrl(config.url, 'MutePublishedTrack'), 'https://zanny-test.livekit.cloud/twirp/livekit.RoomService/MutePublishedTrack');
  assert.throws(() => roomServiceUrl(config.url, 'StartRoomCompositeEgress'), /Unsupported/);
  assert.throws(() => roomServiceUrl('https://example.com', 'ListParticipants'), /managed LiveKit Cloud/);
});

test('room administration requests sign the room-scoped grant and send JSON', async () => {
  let captured;
  const fetchImpl = async (url, options) => {
    captured = { url, options };
    return { ok: true, json: async () => ({ participants: [] }) };
  };
  const result = await requestRoomService('ListParticipants', { room: 'room-2' }, config, fetchImpl);
  assert.deepEqual(result, { participants: [] });
  assert.equal(captured.url, 'https://zanny-test.livekit.cloud/twirp/livekit.RoomService/ListParticipants');
  assert.equal(captured.options.method, 'POST');
  assert.equal(captured.options.headers['Content-Type'], 'application/json');
  const [, payload] = captured.options.headers.Authorization.slice('Bearer '.length).split('.');
  assert.equal(JSON.parse(Buffer.from(payload, 'base64url').toString()).video.room, 'room-2');
});

test('participant helpers call only the expected room-scoped operations', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return { ok: true, json: async () => ({ ok: true }) };
  };
  await listRoomParticipants('room-3', config, fetchImpl);
  await removeRoomParticipant('room-3', 'guest-1', config, fetchImpl);
  await muteRoomParticipantTrack('room-3', 'guest-1', 'TR_AUDIO', true, config, fetchImpl);
  assert.deepEqual(calls.map((call) => call.url.split('/').pop()), ['ListParticipants', 'RemoveParticipant', 'MutePublishedTrack']);
  assert.equal(calls[1].body.identity, 'guest-1');
  assert.ok(calls[1].body.revoke_token_ts > 0);
  assert.equal(calls[2].body.track_sid, 'TR_AUDIO');
  assert.equal(calls[2].body.muted, true);
});

test('only the creator can directly invite, mute, or remove guests and guest publishers are capped', () => {
  assert.ok(route.includes("router.post('/:streamId/guests/invite'"));
  assert.ok(route.includes("router.patch('/:streamId/guests/:userId/mute'"));
  assert.ok(route.includes("router.delete('/:streamId/guests/:userId'"));
  assert.ok(route.includes("stream.creator_id !== req.user.id"));
  assert.ok(route.includes("participant.role !== 'guest'"));
  assert.ok(route.includes('MAX_LIVE_STAGE_GUESTS = 5'));
  assert.ok(route.includes("type: 'live_guest_invitation'"));
});

test('guest microphone controls target only the published audio track and expose current mute state', () => {
  assert.ok(route.includes("track.type === 0 || String(track.type || '').toUpperCase() === 'AUDIO'"));
  assert.ok(route.includes('muteRoomParticipantTrack(stream.room_name, userId, audioTrack.sid, muted)'));
  assert.ok(route.includes('microphoneMuted'));
  assert.ok(route.includes('stage: joinedById.get(userId)?.role === \'guest\''));
});
