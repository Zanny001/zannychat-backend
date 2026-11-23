const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHmac } = require('node:crypto');
const { createLiveKitToken } = require('../src/services/livekitToken');

const route = fs.readFileSync(path.join(__dirname, '../src/routes/liveStreams.js'), 'utf8');
const migration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261110070014_creator_live_streams.sql'), 'utf8');
const experienceMigration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261118221000_live_experience_modes.sql'), 'utf8');
const removalMigration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261118223000_block_removed_live_participants.sql'), 'utf8');

test('LIVE creator follow, stream start, private invitations and guest decisions send push notifications', () => {
  assert.ok(route.includes("require('../config/pushClient')"));
  assert.ok(route.includes('async function notifyLiveUsers(userIds, notification)'));
  assert.ok(route.includes('async function notifyCreatorFollowers(creatorId, notification)'));
  assert.ok(route.includes("type: 'live_creator_follow'"));
  assert.ok(route.includes("type: 'live_stream_started'"));
  assert.ok(route.includes("type: 'live_invitation'"));
  assert.ok(route.includes("type: 'live_guest_request'"));
  assert.ok(route.includes("type: 'live_guest_decision'"));
  assert.ok(route.includes('getBlockedUserIds(creatorId, followerIds)'));
  assert.ok(route.includes('Promise.allSettled(batch.map((userId) => sendPushToUser(userId, notification)))'));
});

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
  assert.ok(route.includes("const REACTIONS = new Set(['heart','clap','laugh','wow','fire','idea','support'])"));
  assert.ok(route.includes("const REASONS = new Set(['harassment','hate','nudity','violence','spam','copyright','other'])"));
  assert.ok(route.includes('stream.creator_id !== req.user.id'));
  assert.ok(route.includes("const canPublish = role === 'creator' || role === 'guest'"));
  assert.ok(route.includes("issueToken(req.user, stream.room_name, config, canPublish, stream.experience_mode === 'audio_room')"));
  assert.ok(route.includes("role, canPublish, canModerate"));
});

test('LIVE supports separate broadcast, themed video chat and audio room modes with category validation', () => {
  assert.ok(experienceMigration.includes("DEFAULT 'broadcast'"));
  assert.ok(experienceMigration.includes("CHECK (experience_mode IN ('broadcast', 'video_chat', 'audio_room'))"));
  assert.ok(experienceMigration.includes("CHECK (category IN ("));
  assert.ok(route.includes("LIVE_EXPERIENCE_MODES = new Set(['broadcast', 'video_chat', 'audio_room'])"));
  assert.ok(route.includes('LIVE_CATEGORIES.has(category)'));
  assert.ok(route.includes("experienceMode !== 'broadcast' || category !== 'social'"));
  assert.ok(route.includes("update({ experience_mode: experienceMode, category })"));
});

test('LIVE reaction admission matches the SQL writer joined-state guard and reports lifecycle errors accurately', () => {
  const helperStart = route.indexOf('async function requireJoined');
  const helperEnd = route.indexOf('\n}', helperStart) + 2;
  const helper = route.slice(helperStart, helperEnd);
  assert.match(helper, /\.eq\('status', 'joined'\)/);
  assert.match(helper, /\.is\('left_at', null\)/);
  const reactionStart = route.indexOf("router.post('/:streamId/react'");
  const reactionEnd = route.indexOf('\n});', reactionStart) + 4;
  const reactionRoute = route.slice(reactionStart, reactionEnd);
  assert.match(reactionRoute, /error\?\.code === '42501'[\s\S]*status\(403\)/);
  assert.match(reactionRoute, /error\?\.code === '22023'[\s\S]*status\(400\)/);
  assert.match(reactionRoute, /error\?\.code === 'P0001'[\s\S]*status\(404\)/);
  assert.match(reactionRoute, /details: error\?\.details/);
});

test('LIVE reaction feed limits to the newest events and restores chronological display order', () => {
  const start = route.indexOf(".select('id,user_id,reaction,created_at')");
  const end = route.indexOf('return res.json({ comments, reactions })', start);
  const body = route.slice(start, end);
  assert.match(body, /\.order\('created_at', \{ ascending: false \}\)/);
  assert.match(body, /\.limit\(100\)/);
  assert.match(body, /\.reverse\(\)/);
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

const lifecycleMigration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261110192254_atomic_live_lifecycle_20261110220000.sql'), 'utf8');

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

const moderationMigration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261110192312_live_moderation_workflows_20261111000000.sql'), 'utf8');

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
  assert.ok(route.includes("in('role', ['viewer','guest']).eq('status', 'joined')"));
  assert.ok(route.includes("router.post('/:streamId/moderators'"));
  assert.ok(route.includes("router.delete('/:streamId/moderators/:userId'"));
});

const accessMigration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261110192318_live_followers_private_guests_20261111010000.sql'), 'utf8');

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


test('LIVE comments expose profile display names without returning raw user IDs', () => {
  assert.ok(route.includes("async function getProfileNames(userIds)"));
  assert.ok(route.includes("from('profiles')"));
  assert.ok(route.includes(".select('id,name').in('id', ids)"));
  assert.ok(route.includes("user_name: names.get(_userId) || 'ZannyChat user'"));
  assert.ok(route.includes("const { user_id: _userId, ...comment } = row"));
  assert.ok(route.includes("const { user_id: _userId, ...comment } = data"));
});

test('LIVE comments response includes a bounded recent reaction feed for floating stage animations', () => {
  assert.ok(route.includes("const reactionSince = new Date(Date.now() - 12 * 1000).toISOString()"));
  assert.ok(route.includes(".select('id,user_id,reaction,created_at')"));
  assert.ok(route.includes(".gt('created_at', reactionSince)"));
  assert.ok(route.includes(".limit(100)"));
  assert.ok(route.includes("return res.json({ comments, reactions })"));
});

test('LIVE reaction writes have a dedicated per-user rate limit', () => {
  assert.ok(route.includes("router.post('/:streamId/react', makeLimiter({ windowMs: 10 * 1000, max: 8"));
});

test('LIVE invitations include accepted guest-stage invitations and prefer stage access per stream', () => {
  assert.ok(route.includes(".in('invitation_type', ['viewer','guest']).in('status', ['pending','accepted'])"));
  assert.ok(route.includes("row.invitation_type === 'viewer' && row.status === 'pending'"));
  assert.ok(route.includes("row.invitation_type === 'guest' && row.status === 'accepted'"));
  assert.ok(route.includes("type: 'live_guest_invitation'"));
});

test('creator impact API exposes per-emoji reaction collection and future milestones', () => {
  assert.ok(route.includes("'get_live_creator_reaction_breakdown'"));
  assert.ok(route.includes('reactionBreakdown: Array.isArray(reactionBreakdown)'));
  assert.ok(route.includes("id: 'legendary-presence'"));
  assert.ok(route.includes("id: 'hall-of-fame'"));
  assert.ok(route.includes('nextMilestone'));
});


test('LIVE viewers cannot publish arbitrary LiveKit data packets', () => {
  assert.ok(route.includes('canPublishData: false'));
  assert.ok(route.includes('canPublish,'));
});


test('LIVE discovery returns creator display names only after visibility and block filtering', () => {
  const publicRouteStart = route.indexOf("router.get('/', async (req, res) => {");
  const publicRouteEnd = route.indexOf("router.post('/', async (req, res) =>", publicRouteStart);
  const publicRoute = route.slice(publicRouteStart, publicRouteEnd);
  const followingRouteStart = route.indexOf("router.get('/following/streams', async (req, res) =>");
  const followingRouteEnd = route.indexOf("router.get('/', async (req, res) =>", followingRouteStart);
  const followingRoute = route.slice(followingRouteStart, followingRouteEnd);

  for (const discoveryRoute of [publicRoute, followingRoute]) {
    assert.ok(discoveryRoute.includes('getBlockedUserIds(req.user.id'));
    assert.ok(discoveryRoute.includes('getProfileNames(visible.map((stream) => stream.creator_id))'));
    assert.ok(discoveryRoute.includes('creator_name: creatorNames.get(stream.creator_id) || \'ZannyChat creator\''));
    assert.ok(discoveryRoute.indexOf('getBlockedUserIds') < discoveryRoute.indexOf('getProfileNames'));
  }
  assert.ok(publicRoute.includes(".eq('visibility', 'public')"));
  assert.ok(followingRoute.includes(".in('visibility', ['public','followers'])"));
});


test('public LIVE discovery includes visibility so client Public filtering retains public streams', () => {
  const publicRouteStart = route.indexOf("router.get('/', async (req, res) => {");
  const publicRouteEnd = route.indexOf("router.post('/', async (req, res) =>", publicRouteStart);
  const publicRoute = route.slice(publicRouteStart, publicRouteEnd);
  assert.match(publicRoute, /\.select\('id,creator_id,title,description,visibility,started_at,viewer_limit'\)/);
  assert.match(publicRoute, /\.eq\('visibility', 'public'\)/);
});

test('ending LIVE captures joined participants and best-effort notifies guests and viewers', () => {
  const start = route.indexOf("router.post('/:streamId/end', async (req, res) =>");
  const end = route.indexOf('\n});', start) + 4;
  const endRoute = route.slice(start, end);
  assert.ok(endRoute.includes("from('live_stream_participants')"));
  assert.ok(endRoute.includes(".eq('stream_id', streamId)"));
  assert.ok(endRoute.includes(".eq('status', 'joined')"));
  assert.ok(endRoute.includes("participantIds.filter((id) => id !== stream.creator_id)"));
  assert.ok(endRoute.includes("type: 'live_stream_ended'"));
  assert.ok(endRoute.includes("title: 'LIVE has ended'"));
  assert.ok(endRoute.indexOf("from('live_stream_participants')") < endRoute.indexOf("rpc('end_live_stream'"));
  assert.ok(endRoute.includes('void notifyLiveUsers'));
});

test('LIVE join payload selects experience mode and category from the persisted stream row', () => {
  assert.ok(route.includes("experience_mode,category"));
  assert.ok(route.includes("experienceMode !== 'broadcast' || category !== 'social'"));
  assert.ok(route.includes(".update({ experience_mode: experienceMode, category })"));
});


test('Audio LIVE Room tokens restrict publishers to microphone tracks only', () => {
  const config = { url: 'wss://media.example.invalid', apiKey: 'key-1', apiSecret: 'secret-1' };
  const token = createLiveKitToken({
    identity: 'audio-host', room: 'zlive-audio', canPublish: true,
    canPublishSources: ['microphone'], nowSeconds: 1_800_000_000, config,
  });
  const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
  assert.equal(payload.video.canPublish, true);
  assert.deepEqual(payload.video.canPublishSources, ['microphone']);
  assert.ok(route.includes("experienceMode === 'audio_room'"));
  assert.ok(route.includes("stream.experience_mode === 'audio_room'"));
  assert.ok(route.includes("canPublishSources: ['microphone']"));
});

test('creator-removed LIVE participants are blocked atomically inside database admission', () => {
  assert.ok(removalMigration.includes("IF v_existing_status = 'blocked' THEN"));
  assert.ok(removalMigration.includes("USING ERRCODE = '42501'"));
  assert.ok(removalMigration.includes('v_stage_joined'));
  assert.ok(removalMigration.includes('v_invite public.live_stream_invites%rowtype'));
  assert.ok(removalMigration.includes("v_stream.visibility = 'followers'"));
  assert.ok(removalMigration.includes("v_stream.visibility = 'private'"));
  assert.ok(route.includes(".update({ status: 'blocked', left_at: now, last_seen_at: now })"));
  assert.ok(route.includes("['joined', 'blocked'].includes(participant.status)"));
  assert.ok(route.includes('removeRoomParticipant(stream.room_name, userId)'));
});

test('LIVE join tokens expire within LiveKit Cloud token revocation window', () => {
  const config = { url: 'wss://media.example.invalid', apiKey: 'key-1', apiSecret: 'secret-1' };
  const token = createLiveKitToken({
    identity: 'viewer-short-ttl', room: 'zlive-short-ttl',
    ttlSeconds: 300, nowSeconds: 1_800_000_000, config,
  });
  const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
  assert.equal(claims.exp - 1_800_000_000, 300);
  assert.ok(route.includes('ttlSeconds: 300'));
});


test('LIVE best-effort RPC cleanup awaits Supabase thenables without calling a missing catch method', () => {
  assert.match(route, /try\s*\{\s*await supabaseAdmin\.rpc\('finalize_live_replay_quota'/);
  assert.match(route, /try\s*\{\s*await supabaseAdmin\.rpc\('end_live_stream'/);
  assert.doesNotMatch(route, /supabaseAdmin\.rpc\([^\n]*\)\.catch\(/);
});


test('LIVE guest requests expose display names and avatar colors for creator approval UI', () => {
  assert.ok(route.includes(".select('id,name,avatar_color').in('id', userIds)"));
  assert.ok(route.includes('avatarColor: profile?.avatar_color || null'));
});

test('LIVE creator roster includes the host, participant identity, camera and microphone state', () => {
  assert.ok(route.includes('const userIds = [...new Set([stream.creator_id, ...joinedById.keys(), ...moderatorIds])]'));
  assert.ok(route.includes(".select('id,name,avatar_color').in('id', userIds)"));
  assert.ok(route.includes("String(track.type || '').toUpperCase() === 'VIDEO'"));
  assert.ok(route.includes('cameraEnabled: typeof video?.muted === \'boolean\' ? !video.muted : Boolean(video)'));
  assert.ok(route.includes("role: isCreator ? 'creator' : participant?.role || null"));
  assert.ok(route.includes('avatarColor: profile?.avatar_color || null'));
});


test('LIVE roster reports actual media connection status without granting creator moderator controls', () => {
  assert.ok(route.includes('moderator: moderatorIds.has(userId)'));
  assert.ok(route.includes("connectionStatus: mediaByIdentity.has(userId) ? 'connected' : 'not_connected'"));
});

test('Direct LIVE guest invitations require recipient consent before stage publishing is granted', () => {
  const inviteStart = route.indexOf("router.post('/:streamId/guests/invite'");
  const inviteEnd = route.indexOf("\n});", inviteStart) + 4;
  const inviteRoute = route.slice(inviteStart, inviteEnd);
  assert.match(inviteRoute, /invitation_type: 'guest', status: 'pending'/);
  assert.doesNotMatch(inviteRoute, /invitation_type: 'guest', status: 'accepted'/);
  const decisionStart = route.indexOf("router.patch('/:streamId/guest-invitation'");
  const decisionEnd = route.indexOf("\n});", decisionStart) + 4;
  const decisionRoute = route.slice(decisionStart, decisionEnd);
  assert.match(decisionRoute, /\['accepted', 'declined'\]/);
  assert.match(decisionRoute, /\.eq\('user_id', req\.user\.id\)/);
  assert.match(decisionRoute, /\.eq\('status', 'pending'\)/);
  assert.match(decisionRoute, /\.eq\('invited_by', stream\.creator_id\)/);
  assert.match(decisionRoute, /type: 'live_guest_decision'/);
  assert.match(decisionRoute, /hasBlockBetween\(stream\.creator_id, req\.user\.id\)/);
  assert.match(decisionRoute, /Guest participation is disabled/);
});


test('LIVE guest join validates requested audio/video mode and limits audio-only publish sources', () => {
  const joinStart = route.indexOf("router.post('/:streamId/join'");
  const joinEnd = route.indexOf("\n});", joinStart) + 4;
  const joinRoute = route.slice(joinStart, joinEnd);
  assert.match(joinRoute, /requestedMediaMode !== undefined && !\['audio', 'video'\]\.includes\(requestedMediaMode\)/);
  assert.match(joinRoute, /const guestMediaMode = stream\.experience_mode === 'audio_room'[\s\S]*requestedMediaMode \|\| 'video'/);
  assert.match(joinRoute, /role === 'guest' && guestMediaMode === 'audio'/);
  assert.match(joinRoute, /token, role, canPublish, canModerate, mediaMode/);
  assert.match(route, /canPublishSources: \['microphone'\]/);
});
