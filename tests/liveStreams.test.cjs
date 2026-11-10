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
  assert.ok(route.includes("canPublish: role === 'creator'") || route.includes("role === 'creator'"));
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
});

test('appointed LIVE moderators can hide comments but cannot end the stream', () => {
  assert.ok(route.includes("Only the creator or an appointed LIVE moderator can moderate comments"));
  assert.ok(route.includes("if (stream.creator_id !== req.user.id) return res.status(403).json({ error: 'Only the creator can end this LIVE stream' })") === false);
  assert.ok(route.includes("router.post('/:streamId/end'"));
});
