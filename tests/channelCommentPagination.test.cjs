'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const route = fs.readFileSync(path.join(__dirname, '../src/routes/channels.js'), 'utf8');

test('channel comments return the newest bounded page in chronological display order', () => {
  const start = route.indexOf("router.get('/:channelId/posts/:postId/comments'");
  const end = route.indexOf("router.post('/:channelId/posts/:postId/comments'", start);
  assert.ok(start >= 0 && end > start, 'comments GET route exists');
  const handler = route.slice(start, end);
  assert.match(handler, /order\('created_at', \{ ascending: false \}\)/);
  assert.match(handler, /order\('id', \{ ascending: false \}\)/);
  assert.match(handler, /limit\(pageSize \+ 1\)/);
  assert.match(handler, /const hasMore = .*length > pageSize/);
  assert.match(handler, /const rows = pageRows\.reverse\(\)/);
  assert.match(handler, /nextCursor, hasMore/);
});

test('channel comment pagination validates paired stable cursors and uses a tie-breaker', () => {
  const start = route.indexOf("router.get('/:channelId/posts/:postId/comments'");
  const end = route.indexOf("router.post('/:channelId/posts/:postId/comments'", start);
  const handler = route.slice(start, end);
  assert.match(handler, /Invalid channel comment cursor/);
  assert.match(handler, /normalizeChannelPostCursorTimestamp\(beforeCreatedAt\)/);
  assert.match(handler, /created_at\.lt\./);
  assert.match(handler, /created_at\.eq\./);
  assert.match(handler, /id\.lt\./);
});
