const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const migration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/0049_channel_post_aggregated_stats.sql'), 'utf8');
const route = fs.readFileSync(path.join(__dirname, '../src/routes/channels.js'), 'utf8');

test('channel post statistics aggregate reactions, comments and distinct views in SQL', () => {
  assert.match(migration, /create or replace function public\.get_channel_post_stats/i);
  assert.match(migration, /jsonb_object_agg/i);
  assert.match(migration, /count\(\*\)::bigint/i);
  assert.match(migration, /array_length\(p_post_ids, 1\) > 100/i);
  assert.match(migration, /revoke all on function public\.get_channel_post_stats\(uuid\[\], uuid\) from public, anon, authenticated/i);
  assert.match(migration, /grant execute on function public\.get_channel_post_stats\(uuid\[\], uuid\) to service_role/i);
});

test('channel feed uses aggregate RPC instead of downloading unbounded raw statistics', () => {
  assert.match(route, /rpc\('get_channel_post_stats'/);
  assert.match(route, /reactionCounts: stats\?\.reaction_counts/);
  const feed = route.slice(route.indexOf("router.get('/:channelId/posts',"), route.indexOf("const CHANNEL_REACTION_EMOJIS"));
  assert.doesNotMatch(feed, /from\('channel_post_comments'\)\.select\('post_id'\)/);
  assert.doesNotMatch(feed, /from\('channel_post_views'\)\.select\('post_id'\)/);
});
