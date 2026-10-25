const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const migration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/0034_channel_post_comments.sql'), 'utf8');
const route = fs.readFileSync(path.join(__dirname, '../src/routes/channels.js'), 'utf8');

test('channel comments have bounded text and cascade with post/user deletion', () => {
  assert.match(migration, /body text not null check \(char_length\(btrim\(body\)\) between 1 and 1000\)/i);
  assert.match(migration, /references public\.channel_posts\(id\) on delete cascade/i);
  assert.match(migration, /references public\.profiles\(id\) on delete cascade/i);
});

test('channel comments are RLS protected and service-role mediated', () => {
  assert.match(migration, /alter table public\.channel_post_comments enable row level security/i);
  assert.match(migration, /revoke all on public\.channel_post_comments from anon, authenticated/i);
  assert.match(migration, /grant select, insert, update, delete on public\.channel_post_comments to service_role/i);
  assert.match(route, /router\.post\('\/:channelId\/posts\/:postId\/comments'/);
  assert.match(route, /rpc\('get_channel_post_stats'/);
  assert.match(route, /commentCount: Number\.isSafeInteger\(Number\(stats\?\.comment_count\)\)/);
  assert.match(route, /Subscribe to the channel before commenting/);
  assert.match(route, /Only the comment author, channel owner, or moderator can delete this comment/);
});
