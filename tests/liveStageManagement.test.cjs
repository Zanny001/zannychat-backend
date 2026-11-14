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
  updateRoomParticipantAttributes,
  updateRoomParticipantPermissions,
  validateRoomAdminCredentials,
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
  assert.equal(roomServiceUrl(config.url, 'UpdateParticipant'), 'https://zanny-test.livekit.cloud/twirp/livekit.RoomService/UpdateParticipant');
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

test('participant helper can update a single room-scoped spotlight attribute', async () => {
  let captured;
  const fetchImpl = async (url, options) => {
    captured = { url, body: JSON.parse(options.body) };
    return { ok: true, json: async () => ({ identity: 'guest-2' }) };
  };
  await updateRoomParticipantAttributes('room-4', 'guest-2', { zannychat_spotlight: 'true' }, config, fetchImpl);
  assert.equal(captured.url.endsWith('/UpdateParticipant'), true);
  assert.deepEqual(captured.body, { room: 'room-4', identity: 'guest-2', attributes: { zannychat_spotlight: 'true' } });
});

test('spotlight changes are creator-only, stage-guest-only and clear any previous spotlight', () => {
  assert.ok(route.includes("router.patch('/:streamId/guests/:userId/spotlight'"));
  assert.ok(route.includes("Only the creator can manage the LIVE spotlight"));
  assert.ok(route.includes("participant.attributes?.zannychat_spotlight === 'true'"));
  assert.ok(route.includes("zannychat_spotlight: spotlighted ? 'true' : ''"));
  assert.ok(route.includes('spotlighted: mediaByIdentity.get(userId)?.spotlighted ?? false'));
});

test('room-admin credential validation uses a read-only participant lookup and treats a missing probe room as authenticated', async () => {
  let requestedUrl = '';
  const authenticated = await validateRoomAdminCredentials(config, async (url) => {
    requestedUrl = url;
    return { ok: false, status: 404 };
  });
  assert.equal(authenticated, true);
  assert.ok(requestedUrl.endsWith('/ListParticipants'));
});

test('room-admin credential validation does not hide authentication failures', async () => {
  await assert.rejects(
    validateRoomAdminCredentials(config, async () => ({ ok: false, status: 401 })),
    /HTTP 401/,
  );
});

test('guest removal demotes the guest to a subscribed viewer without removing the room participant', async () => {
  let captured;
  const fetchImpl = async (url, options) => {
    captured = { url, body: JSON.parse(options.body) };
    return { ok: true, json: async () => ({ identity: 'guest-3' }) };
  };
  await updateRoomParticipantPermissions('room-5', 'guest-3', {
    canPublish: false, canSubscribe: true, canPublishData: true,
  }, config, fetchImpl);
  assert.ok(captured.url.endsWith('/UpdateParticipant'));
  assert.deepEqual(captured.body.permission, { canPublish: false, canSubscribe: true, canPublishData: true });
});

test('creator guest removal preserves audience membership when LiveKit demotion succeeds', () => {
  assert.ok(route.includes('updateRoomParticipantPermissions(stream.room_name, userId'));
  assert.ok(route.includes("update({ role: 'viewer', status: 'joined', left_at: null })"));
  assert.ok(route.includes('returnedToAudience'));
  assert.ok(route.includes('canSubscribe: true'));
  assert.ok(route.includes("updateRoomParticipantAttributes(stream.room_name, userId, { zannychat_spotlight: '' })"));
  assert.ok(!route.includes('removeRoomParticipant(stream.room_name, userId)'));
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

test('guest publisher capacity is enforced atomically inside the locked join RPC', () => {
  const migration = require('node:fs').readFileSync(require('node:path').join(__dirname, '../supabase/migrations/20261114123057_live_stage_guest_capacity.sql'), 'utf8');
  assert.ok(migration.includes('FOR UPDATE'));
  assert.ok(migration.includes("IF v_role = 'guest' THEN"));
  assert.ok(migration.includes("AND role = 'guest'"));
  assert.ok(migration.includes("AND status = 'joined'"));
  assert.ok(migration.includes('AND user_id <> p_user_id'));
  assert.ok(migration.includes('IF v_stage_joined >= 5 THEN'));
  assert.ok(route.includes("/LIVE stage is full/i"));
});
