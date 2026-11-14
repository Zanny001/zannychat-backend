const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const route = fs.readFileSync(path.join(__dirname, '../src/routes/liveStreams.js'), 'utf8');

test('LIVE creator profile summary is authenticated and only reads the signed-in creator', () => {
  assert.ok(route.includes("router.get('/creators/me/profile'"));
  assert.ok(route.includes("router.use(requireAuth"));
  assert.ok(route.includes("const creatorId = req.user.id"));
  assert.ok(route.includes(".eq('creator_id', creatorId)"));
});

test('LIVE creator profile summary returns impact, followers, stream and replay collections', () => {
  assert.ok(route.includes(".from('live_creator_impact')"));
  assert.ok(route.includes(".from('live_creator_follows').select('follower_id', { count: 'exact', head: true })"));
  assert.ok(route.includes("liveNow: streams.filter((row) => row.status === 'live').length"));
  assert.ok(route.includes("ready: replays.filter((row) => row.status === 'ready').length"));
  assert.ok(route.includes('unique_supporters'));
  assert.ok(route.includes('total_reactions'));
});

test('LIVE creator profile summary exposes limited recent metadata, not private supporter identities', () => {
  assert.ok(route.includes('streams.slice(0, 8)'));
  assert.ok(route.includes('replays.slice(0, 8)'));
  assert.equal(route.includes(".from('live_creator_impact_supporters')"), false);
  assert.equal(route.includes(".from('live_creator_impact_daily')"), false);
});
