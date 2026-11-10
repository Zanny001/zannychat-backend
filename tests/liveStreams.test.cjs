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
