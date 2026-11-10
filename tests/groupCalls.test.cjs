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

const departureMigration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261110190000_atomic_group_call_departure.sql'), 'utf8');

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

const endAndTypeMigration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261110200000_atomic_group_call_end_and_call_type.sql'), 'utf8');

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

const createCallMigration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261110210000_atomic_group_call_creation.sql'), 'utf8');

test('group-call creation inserts the room and all invitations atomically after validating group membership', () => {
  assert.ok(createCallMigration.includes('FUNCTION public.create_group_call_room('));
  assert.ok(createCallMigration.includes('public.conversations c'));
  assert.ok(createCallMigration.includes('public.conversation_participants cp'));
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
