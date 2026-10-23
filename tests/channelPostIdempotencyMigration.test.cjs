const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
test('channel post idempotency migration adds nullable request key and scoped unique index', () => {
  const sql = fs.readFileSync(path.join(root, 'supabase/migrations/0046_channel_post_idempotency.sql'), 'utf8');
  assert.match(sql, /add column if not exists client_request_id uuid/i);
  assert.match(sql, /unique index if not exists channel_posts_client_request_unique/i);
  assert.match(sql, /channel_id, author_id, client_request_id/i);
  assert.match(sql, /where client_request_id is not null/i);
});
test('channel publish route validates request IDs and recovers existing post on retry', () => {
  const route = fs.readFileSync(path.join(root, 'src/routes/channels.js'), 'utf8');
  const section = route.slice(route.indexOf("router.post('/:channelId/posts',"), route.indexOf("router.get('/:channelId/posts/:postId/comments',"));
  assert.match(section, /clientRequestId/);
  assert.match(section, /client_request_id/);
  assert.match(section, /error\.code === '23505'/);
  assert.match(section, /deduplicated: true/);
  assert.equal((section.match(/existing\.body !== body/g) || []).length, 2, 'both normal retry and unique-index race reject a reused key with different content');
  assert.match(section, /status\(409\)/);
});
