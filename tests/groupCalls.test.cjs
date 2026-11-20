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
  assert.ok(route.includes("rpc('end_group_call_room'"));
  assert.ok(route.includes('Only the call host or a group admin can end this call'));
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

const departureMigration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261110192237_atomic_group_call_departure_20261110190000.sql'), 'utf8');

test('group-call departure serializes on the room row and ends the room atomically', () => {
  assert.ok(departureMigration.includes('FUNCTION public.leave_group_call_room(p_room_id uuid, p_user_id uuid)'));
  assert.ok(departureMigration.includes('FROM public.group_call_rooms'));
  assert.ok(departureMigration.includes('FOR UPDATE'));
  assert.ok(departureMigration.includes("status = 'joined'"));
  assert.ok(departureMigration.includes('GET DIAGNOSTICS v_updated = ROW_COUNT'));
  assert.ok(departureMigration.includes('IF v_updated = 0 THEN'));
  assert.ok(departureMigration.includes("IF v_joined = 0 AND v_room.status IN ('ringing','active')"));
  assert.ok(departureMigration.includes("SET status = 'ended'"));
  assert.ok(departureMigration.includes('TO service_role'));
  assert.ok(route.includes("rpc('leave_group_call_room'"));
  assert.ok(route.includes('roomEnded: roomEnded === true'));
});

const endAndTypeMigration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261110192243_atomic_group_call_end_and_call_type_20261110200000.sql'), 'utf8');

test('group-call end is serialized, rechecks host/admin authorization, and updates all invitations', () => {
  assert.ok(endAndTypeMigration.includes('FUNCTION public.end_group_call_room(p_room_id uuid, p_user_id uuid)'));
  assert.ok(endAndTypeMigration.includes('FROM public.group_call_rooms'));
  assert.ok(endAndTypeMigration.includes('FOR UPDATE'));
  assert.ok(endAndTypeMigration.includes('FROM public.conversation_participants cp'));
  assert.ok(endAndTypeMigration.includes('FOR SHARE'));
  assert.ok(endAndTypeMigration.includes('p_user_id <> v_room.host_user_id AND NOT v_is_admin'));
  assert.ok(endAndTypeMigration.includes("status IN ('invited','joined')"));
  assert.ok(endAndTypeMigration.includes('TO service_role'));
  assert.ok(route.includes("rpc('end_group_call_room'"));
});

test('group-call room schema includes the call_type column used by API routes', () => {
  assert.ok(endAndTypeMigration.includes('ADD COLUMN IF NOT EXISTS call_type text'));
  assert.ok(endAndTypeMigration.includes("CHECK (call_type IN ('audio','video'))"));
  assert.ok(route.includes("call_type: callType"));
});

const createCallMigration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261110192249_atomic_group_call_creation_20261110210000.sql'), 'utf8');

test('group-call creation inserts the room and all invitations atomically after validating group membership', () => {
  assert.ok(createCallMigration.includes('FUNCTION public.create_group_call_room('));
  assert.ok(createCallMigration.includes('public.conversations c'));
  assert.ok(createCallMigration.includes('public.conversation_participants cp'));
  assert.ok(createCallMigration.includes('public.blocked_users'));
  assert.ok(createCallMigration.includes('blocked group member cannot be invited'));
  assert.ok(createCallMigration.includes('FOR SHARE'));
  assert.ok(createCallMigration.includes('INSERT INTO public.group_call_rooms'));
  assert.ok(createCallMigration.includes('INSERT INTO public.group_call_participants'));
  assert.ok(createCallMigration.includes('TO service_role'));
  assert.ok(route.includes("rpc('create_group_call_room'"));
  assert.equal(route.includes(".from('group_call_participants').insert(participantRows)"), false);
});

test('abandoned host-only group calls are closed before another call starts and expired invites show missed', () => {
  assert.ok(createCallMigration.includes('FOR v_stale_room IN'));
  assert.ok(createCallMigration.includes("COALESCE(r.started_at, r.created_at) <= v_now - interval '2 minutes'"));
  assert.ok(createCallMigration.includes("p.status = 'joined'"));
  assert.ok(createCallMigration.includes("p.user_id <> v_stale_room.host_user_id"));
  assert.ok(createCallMigration.includes("status = 'invited'"));
  assert.ok(route.includes('Date.parse(participant.invited_at) <= Date.now() - 2 * 60 * 1000'));
  assert.ok(route.includes("? 'missed'"));
});

test('group call history distinguishes unanswered invitations from participants who left', () => {
  assert.ok(route.includes("const neverJoined = !participant.joined_at && ['invited','left'].includes(participant.status)"));
  assert.ok(route.includes("neverJoined && (room.status === 'ended' || invitationExpired) ? 'missed'"));
  assert.ok(route.includes("participant.status === 'left' || room.status === 'ended' ? 'ended'"));
});

const renderConfig = fs.readFileSync(path.join(__dirname, '../render.yaml'), 'utf8');

test('Render blueprint prompts for server-only LiveKit credentials without storing secrets', () => {
  for (const key of ['LIVEKIT_URL','LIVEKIT_API_KEY','LIVEKIT_API_SECRET']) {
    assert.ok(renderConfig.includes(`- key: ${key}\n        sync: false`));
  }
});


const { createRoomDeletionToken, liveKitHttpUrl, deleteLiveKitRoom } = require('../src/services/livekitRoomAdmin');
const { cleanupEndedGroupCallMedia } = require('../src/jobs/groupCallMediaCleanup');
const mediaTeardownMigration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261112104338_group_call_media_teardown.sql'), 'utf8');

test('LiveKit DeleteRoom credentials use the required short-lived server-side roomCreate grant', () => {
  const config = { url: 'wss://media.example.invalid', apiKey: 'key-1', apiSecret: 'secret-1' };
  const token = createRoomDeletionToken(config, 1_800_000_000);
  const [header, payload, signature] = token.split('.');
  const expected = createHmac('sha256', config.apiSecret).update(header + '.' + payload).digest('base64url');
  assert.equal(signature, expected);
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url').toString('utf8')), { alg: 'HS256', typ: 'JWT' });
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  assert.equal(claims.exp - claims.nbf, 35);
  assert.deepEqual(claims.video, { roomCreate: true });
  assert.equal(liveKitHttpUrl(config.url), 'https://media.example.invalid/twirp/livekit.RoomService/DeleteRoom');
});

test('LiveKit room deletion uses authenticated server-side Twirp request and rejects malformed room ids', async () => {
  let request;
  const config = { url: 'wss://media.example.invalid', apiKey: 'key-1', apiSecret: 'secret-1' };
  const result = await deleteLiveKitRoom('zgc_0123456789abcdef0123456789abcdef', {
    config,
    nowSeconds: 1_800_000_000,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, status: 200, text: async () => '' };
    },
  });
  assert.deepEqual(result, { deleted: true, alreadyAbsent: false });
  assert.equal(request.url, 'https://media.example.invalid/twirp/livekit.RoomService/DeleteRoom');
  assert.equal(request.options.method, 'POST');
  assert.equal(JSON.parse(request.options.body).room, 'zgc_0123456789abcdef0123456789abcdef');
  assert.match(request.options.headers.Authorization, /^Bearer [A-Za-z0-9_.-]+$/);
  await assert.rejects(() => deleteLiveKitRoom('not-a-zanny-room', { config, fetchImpl: async () => ({ ok: true, status: 200 }) }), /Invalid ZannyChat LiveKit room name/);
});

test('ended group-call media cleanup records success and leaves failures retryable', async () => {
  const updates = [];
  const rooms = [
    { id: 'room-1', room_name: 'zgc_0123456789abcdef0123456789abcdef' },
    { id: 'room-2', room_name: 'zgc_fedcba9876543210fedcba9876543210' },
  ];
  const admin = {
    from(table) {
      assert.equal(table, 'group_call_rooms');
      const query = {
        operation: 'select',
        values: null,
        select() { this.operation = 'select'; return this; },
        update(values) { this.operation = 'update'; this.values = values; return this; },
        eq() { return this; },
        is() { return this; },
        order() { return this; },
        limit() { return this; },
        in() { return this; },
        then(resolve, reject) {
          if (this.operation === 'select') return Promise.resolve({ data: rooms, error: null }).then(resolve, reject);
          updates.push(this.values);
          return Promise.resolve({ data: null, error: null }).then(resolve, reject);
        },
      };
      return query;
    },
  };
  const result = await cleanupEndedGroupCallMedia({
    admin,
    now: () => new Date('2026-11-12T10:00:00.000Z'),
    deleteRoom: async (name) => { if (name.includes('fedcba')) throw new Error('SFU unavailable'); },
  });
  assert.deepEqual(result, { checked: 2, terminated: 1, failed: 1 });
  assert.deepEqual(updates, [{ media_terminated_at: '2026-11-12T10:00:00.000Z' }]);
  assert.ok(mediaTeardownMigration.includes('ADD COLUMN IF NOT EXISTS media_terminated_at'));
  assert.ok(mediaTeardownMigration.includes("status = 'ended' AND media_terminated_at IS NULL"));
  assert.ok(route.includes('cleanupEndedGroupCallMedia'));
  assert.ok(route.includes('mediaTerminationPending'));
});


test('LiveKit room-admin requests refuse insecure transport in production', () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    assert.throws(() => liveKitHttpUrl('ws://media.example.invalid'), /secure wss or https transport/);
    assert.equal(liveKitHttpUrl('wss://media.example.invalid'), 'https://media.example.invalid/twirp/livekit.RoomService/DeleteRoom');
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});


const joinBlockMigration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261115014903_harden_group_call_join_block_privacy.sql'), 'utf8');

test('group-call admission rechecks bidirectional blocks against joined and invited participants', () => {
  assert.ok(joinBlockMigration.includes('CREATE OR REPLACE FUNCTION public.join_group_call_room(p_room_id uuid, p_user_id uuid)'));
  assert.ok(joinBlockMigration.includes('b.blocker_id = p_user_id AND b.blocked_id = current_participant.user_id'));
  assert.ok(joinBlockMigration.includes('b.blocker_id = current_participant.user_id AND b.blocked_id = p_user_id'));
  assert.ok(joinBlockMigration.includes("current_participant.status = 'joined'"));
  assert.ok(joinBlockMigration.includes('blocked users cannot share a group call'));
  assert.ok(joinBlockMigration.includes('FOR UPDATE'));
  assert.ok(joinBlockMigration.includes('REVOKE ALL ON FUNCTION public.join_group_call_room(uuid, uuid) FROM PUBLIC, anon, authenticated'));
  assert.ok(joinBlockMigration.includes('GRANT EXECUTE ON FUNCTION public.join_group_call_room(uuid, uuid) TO service_role'));
});


test('group-call LiveKit tokens do not expose unused data-channel publishing', () => {
  assert.ok(route.includes('canPublishData: false'));
});


test('group call creation, invite and direct-call promotion enforce recipient call preferences before RPC/push', () => {
  assert.ok(route.includes("require('../utils/callInvitePrivacy.cjs')"));
  assert.ok(route.includes("select('user_id,call_permission')"));
  assert.ok(route.includes('loadCallInvitePrivacyContext'));

  const upgradeStart = route.indexOf("router.post('/upgrade/:callId'");
  const createStart = route.indexOf("router.post('/',");
  const inviteStart = route.indexOf("router.post('/:roomId/invite'");
  const leaveStart = route.indexOf("router.post('/:roomId/leave'");
  const upgrade = route.slice(upgradeStart, createStart);
  const create = route.slice(createStart, route.indexOf("router.get('/history'", createStart));
  const invite = route.slice(inviteStart, leaveStart);

  assert.ok(upgrade.indexOf('evaluateCallInvitePrivacy(') < upgrade.indexOf("rpc('promote_direct_call_to_group_room_with_media'"));
  assert.ok(create.includes('candidateInviteeIds.filter'));
  assert.ok(create.includes('evaluateCallInvitePrivacy('));
  assert.ok(create.includes('p_invited_user_ids: invitedUserIds'));
  assert.ok(invite.indexOf('evaluateCallInvitePrivacy(') < invite.indexOf("rpc('invite_group_call_participants'"));
});
