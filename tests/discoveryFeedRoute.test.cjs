const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const route = fs.readFileSync(path.resolve(__dirname, '../src/routes/channels.js'), 'utf8');
const start = route.indexOf("router.get('/discover/feed'");
const end = route.indexOf("router.get('/:channelId/posts'", start);
assert.notEqual(start, -1, 'public community feed route must exist');
assert.notEqual(end, -1, 'channel post route must follow the discovery route');
const feed = route.slice(start, end);

test('community discovery only queries public channel posts', () => {
  assert.match(feed, /channels!inner\(title, is_private\)/);
  assert.match(feed, /eq\('channels\.is_private', false\)/);
  assert.match(feed, /channelTitle: post\.channels\?\.title/);
});

test('community discovery excludes authors blocked in either direction', () => {
  assert.match(feed, /from\('blocked_users'\)/);
  assert.match(feed, /blocker_id\.eq\.\$\{req\.user\.id\},blocked_id\.eq\.\$\{req\.user\.id\}/);
  assert.match(feed, /blockedIds\.has\(post\.author_id\)/);
});

test('community feed uses bounded stable cursor pagination', () => {
  assert.match(feed, /const pageSize = 20/);
  assert.match(feed, /limit\(pageSize \+ 1\)/);
  assert.match(feed, /normalizeChannelPostCursorTimestamp\(beforeCreatedAt\)/);
  assert.match(feed, /created_at\.lt\./);
  assert.match(feed, /created_at\.eq\./);
  assert.match(feed, /id\.lt\./);
  assert.match(feed, /Invalid discovery feed cursor/);
  assert.match(feed, /nextCursor,\s*hasMore/);
});

test('community feed records idempotent views and returns aggregated engagement', () => {
  assert.match(feed, /from\('channel_post_views'\)/);
  assert.match(feed, /onConflict: 'post_id,user_id'/);
  assert.match(feed, /ignoreDuplicates: true/);
  assert.match(feed, /rpc\('get_channel_post_stats'/);
  assert.match(feed, /reactionCounts/);
  assert.match(feed, /commentCount/);
  assert.match(feed, /viewCount/);
});

test('personalized community feed responses are not cached', () => {
  assert.match(feed, /Cache-Control', 'no-store'/);
});
