const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHmac } = require('node:crypto');
const { createLiveKitToken } = require('../src/services/livekitToken');

const route = fs.readFileSync(path.join(__dirname, '../src/routes/liveStreams.js'), 'utf8');
const migration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261110070014_creator_live_streams.sql'), 'utf8');

test('LIVE audience tokens are subscribe-only while creator tokens can publish', () => {
  const config = { url: 'wss://media.example.invalid', apiKey: 'key-1', apiSecret: 'secret-1' };
  for (const canPublish of [false, true]) {
    const token = createLiveKitToken({ identity: 'viewer-1', room: 'zlive-1', canPublish, nowSeconds: 1_800_000_000, config });
    const [header, payload, signature] = token.split('.');
    assert.equal(signature, createHmac('sha256', config.apiSecret).update(header + '.' + payload).digest('base64url'));
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    assert.equal(claims.video.canPublish, canPublish);
    assert.equal(claims.video.canSubscribe, true);
    assert.equal(claims.video.room, 'zlive-1');
  }
});

test('LIVE routes require auth and validate audience, comments, reactions, reports and creator controls', () => {
  assert.ok(route.includes('router.use(requireAuth'));
  assert.ok(route.includes(".eq('visibility', 'public')"));
  assert.ok(route.includes("if (!stream.allow_comments)"));
  assert.ok(route.includes("const REACTIONS = new Set(['heart','clap','laugh','wow','fire'])"));
  assert.ok(route.includes("const REASONS = new Set(['harassment','hate','nudity','violence','spam','copyright','other'])"));
  assert.ok(route.includes('stream.creator_id !== req.user.id'));
  assert.ok(route.includes("const canPublish = role === 'creator' || role === 'guest'"));
  assert.ok(route.includes('issueToken(req.user, stream.room_name, config, canPublish)'));
  assert.ok(route.includes("role, canPublish, canModerate"));
});

test('LIVE schema stores audience, moderation, reactions and abuse reports with client access revoked', () => {
  for (const table of ['live_streams','live_stream_participants','live_stream_comments','live_stream_reactions','live_stream_reports']) {
    assert.ok(migration.includes('public.' + table));
  }
  assert.ok(migration.includes("CHECK (visibility IN ('public','followers','private'))"));
  assert.ok(migration.includes("CHECK (moderation_status IN ('visible','hidden','pending'))"));
  assert.ok(migration.includes("CHECK (reason IN ('harassment','hate','nudity','violence','spam','copyright','other'))"));
  assert.ok(migration.includes('REVOKE ALL ON public.live_streams'));
  assert.ok(migration.includes('TO service_role'));
});

const lifecycleMigration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261110220000_atomic_live_lifecycle.sql'), 'utf8');

test('LIVE creation atomically inserts the stream and creator participant', () => {
  assert.ok(lifecycleMigration.includes('FUNCTION public.create_live_stream('));
  assert.ok(lifecycleMigration.includes('INSERT INTO public.live_streams'));
  assert.ok(lifecycleMigration.includes('INSERT INTO public.live_stream_participants'));
  assert.ok(lifecycleMigration.includes('TO service_role'));
  assert.ok(route.includes("rpc('create_live_stream'"));
  assert.equal(route.includes(".from('live_stream_participants').insert({"), false);
});

test('LIVE ending locks the stream and atomically closes all joined participants', () => {
  assert.ok(lifecycleMigration.includes('FUNCTION public.end_live_stream(p_stream_id uuid, p_creator_id uuid)'));
  assert.ok(lifecycleMigration.includes('FOR UPDATE'));
  assert.ok(lifecycleMigration.includes('v_stream.creator_id <> p_creator_id'));
  assert.ok(lifecycleMigration.includes("SET status = 'ended', ended_at = v_now"));
  assert.ok(lifecycleMigration.includes("SET status = 'left', left_at = COALESCE(left_at, v_now)"));
  assert.ok(route.includes("rpc('end_live_stream'"));
});

test('LIVE participant departure locks the stream row to serialize with joins and stream ending', () => {
  assert.ok(lifecycleMigration.includes('FUNCTION public.leave_live_stream(p_stream_id uuid, p_user_id uuid)'));
  assert.ok(lifecycleMigration.includes('FROM public.live_streams'));
  assert.ok(lifecycleMigration.includes('FOR UPDATE'));
  assert.ok(lifecycleMigration.includes('GET DIAGNOSTICS v_updated = ROW_COUNT'));
  assert.ok(lifecycleMigration.includes("p_user_id = v_stream.creator_id"));
  assert.ok(lifecycleMigration.includes("creator must end the LIVE stream"));
  assert.ok(lifecycleMigration.includes('TO service_role'));
  assert.ok(route.includes("rpc('leave_live_stream'"));
});

const moderationMigration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261110240000_live_moderation_workflows.sql'), 'utf8');

test('LIVE creator-appointed moderators are stream-scoped and backend-only', () => {
  assert.ok(moderationMigration.includes('public.live_stream_moderators'));
  assert.ok(moderationMigration.includes('PRIMARY KEY (stream_id, user_id)'));
  assert.ok(moderationMigration.includes('appointed_by uuid NOT NULL'));
  assert.ok(moderationMigration.includes('ENABLE ROW LEVEL SECURITY'));
  assert.ok(moderationMigration.includes('REVOKE ALL ON public.live_stream_moderators'));
  assert.ok(moderationMigration.includes('TO service_role'));
  assert.ok(route.includes("router.post('/:streamId/moderators'"));
  assert.ok(route.includes("router.delete('/:streamId/moderators/:userId'"));
  assert.ok(route.includes("participant.role !== 'viewer'"));
});

test('LIVE report queue and resolution are restricted to creator-appointed moderators', () => {
  assert.ok(moderationMigration.includes('reviewed_by uuid'));
  assert.ok(moderationMigration.includes('reviewed_at timestamptz'));
  assert.ok(route.includes("router.get('/:streamId/reports'"));
  assert.ok(route.includes("router.patch('/:streamId/reports/:reportId'"));
  assert.ok(route.includes('canModerateLive(stream, req.user.id)'));
  assert.ok(route.includes("['reviewing','resolved','dismissed'].includes(status)"));
  assert.ok(route.includes(".in('status', ['open','reviewing'])"));
});

test('appointed LIVE moderators can hide comments but cannot end the stream', () => {
  assert.ok(route.includes("Only the creator or an appointed LIVE moderator can moderate comments"));
  assert.ok(route.includes("rpc('end_live_stream'"));
  assert.ok(route.includes("Only the creator can end this LIVE stream"));
});

test('only the LIVE creator can list joined viewers and manage stream moderators', () => {
  assert.ok(route.includes("router.get('/:streamId/participants'"));
  assert.ok(route.includes("stream.creator_id !== req.user.id"));
  assert.ok(route.includes("eq('role', 'viewer').eq('status', 'joined')"));
  assert.ok(route.includes("router.post('/:streamId/moderators'"));
  assert.ok(route.includes("router.delete('/:streamId/moderators/:userId'"));
});

const accessMigration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261110250000_live_followers_private_guests.sql'), 'utf8');

test('LIVE follower relationships are private to the backend and block-aware', () => {
  assert.ok(accessMigration.includes('public.live_creator_follows'));
  assert.ok(accessMigration.includes('PRIMARY KEY (follower_id, creator_id)'));
  assert.ok(accessMigration.includes('REVOKE ALL ON public.live_creator_follows'));
  assert.ok(route.includes("router.post('/creators/:creatorId/follow'"));
  assert.ok(route.includes("router.delete('/creators/:creatorId/follow'"));
  assert.ok(route.includes("router.get('/following/streams'"));
  assert.ok(route.includes("hasBlockBetween(creatorId, req.user.id)"));
});

test('LIVE follower-only and private admission is enforced inside the locked database function', () => {
  assert.ok(accessMigration.includes('FUNCTION public.join_live_stream(p_stream_id uuid, p_user_id uuid)'));
  assert.ok(accessMigration.includes('FOR UPDATE'));
  assert.ok(accessMigration.includes("v_stream.visibility = 'followers' AND NOT v_is_follower"));
  assert.ok(accessMigration.includes("v_invite.invitation_type IN ('viewer','guest')"));
  assert.ok(accessMigration.includes("v_stream.visibility = 'private'"));
  assert.ok(accessMigration.includes("invitation_type IN ('viewer','guest')"));
  assert.ok(accessMigration.includes('public.live_stream_invites'));
  assert.ok(route.includes("router.post('/:streamId/invites'"));
  assert.ok(route.includes("router.get('/invitations'"));
  assert.ok(route.includes("router.get('/invite-candidates'"));
  assert.ok(route.includes("from('conversation_participants')"));
  assert.ok(route.includes('blockedIds.has(userId)'));
  assert.ok(route.includes("router.get('/following/streams'"));
});

test('LIVE guest publishing requires creator approval and the stream guest switch', () => {
  assert.ok(accessMigration.includes('p_allow_guests boolean'));
  assert.ok(accessMigration.includes('allow_guests'));
  assert.ok(accessMigration.includes("v_stream.allow_guests AND v_has_invite"));
  assert.ok(accessMigration.includes("v_invite.invitation_type = 'guest' AND v_invite.status = 'accepted'"));
  assert.ok(route.includes("router.post('/:streamId/guest-requests'"));
  assert.ok(route.includes("router.get('/:streamId/guest-requests'"));
  assert.ok(route.includes("router.patch('/:streamId/guest-requests/:userId'"));
  assert.ok(route.includes("requester is no longer a joined viewer"));
  assert.ok(route.includes("hasBlockBetween(stream.creator_id, userId)"));
  assert.ok(route.includes("const canPublish = role === 'creator' || role === 'guest'"));
  assert.ok(route.includes("p_visibility: visibility"));
  assert.ok(route.includes("p_allow_guests: allowGuests"));
  assert.ok(route.includes('p_invited_user_ids: inviteeIds'));
  assert.ok(accessMigration.includes('p_invited_user_ids uuid[]'));
  assert.ok(accessMigration.includes("invitation_type, status, created_at, updated_at"));
});
