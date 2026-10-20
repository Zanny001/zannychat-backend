const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const route = fs.readFileSync(path.join(__dirname, '../src/routes/channels.js'), 'utf8');
const migration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/0042_channel_post_views.sql'), 'utf8');
const screen = fs.readFileSync(path.join(__dirname, '../../zannychat-frontend-main/src/screens/ChannelsScreen.js'), 'utf8');

test('channel post views count distinct authenticated users and tolerate repeated loads', () => {
  assert.match(route, /from\('channel_post_views'\)[\s\S]*?onConflict: 'post_id,user_id', ignoreDuplicates: true/);
  assert.match(route, /viewCount: viewCounts\.get\(post\.id\) \|\| 0/);
  assert.match(migration, /primary key \(post_id, user_id\)/);
  assert.match(migration, /revoke all on public\.channel_post_views from anon, authenticated/);
});

test('channel post cards display distinct-viewer count', () => {
  assert.match(screen, /post\.viewCount \|\| 0/);
});
