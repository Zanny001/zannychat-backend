const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const migration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/0055_channel_comment_reactions.sql'), 'utf8');
const route = fs.readFileSync(path.join(__dirname, '../src/routes/channels.js'), 'utf8');

test('channel comment reactions are unique per user and cascade on comment deletion', () => {
  assert.match(migration, /comment_id uuid not null references public\.channel_post_comments\(id\) on delete cascade/i);
  assert.match(migration, /primary key \(comment_id, user_id\)/i);
  assert.match(migration, /emoji in \('👍','❤️','😂','😮','👏'\)/);
});

test('channel comment reaction storage is restricted to backend service role', () => {
  assert.match(migration, /alter table public\.channel_comment_reactions enable row level security/i);
  assert.match(migration, /revoke all on public\.channel_comment_reactions from anon, authenticated/i);
  assert.match(migration, /grant select, insert, update, delete on public\.channel_comment_reactions to service_role/i);
});

test('comment reaction endpoint validates emoji and scopes reaction to authenticated user and post', () => {
  assert.match(route, /router\.put\('\/:channelId\/posts\/:postId\/comments\/:commentId\/reaction'/);
  assert.match(route, /Unsupported comment reaction/);
  assert.match(route, /\.eq\('user_id', req\.user\.id\)/);
  assert.match(route, /\.eq\('post_id', post\.id\)/);
});
