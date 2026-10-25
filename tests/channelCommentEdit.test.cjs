const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const route = fs.readFileSync(path.join(__dirname, '../src/routes/channels.js'), 'utf8');

test('channel comment editing validates bounded non-empty text and only permits the author', () => {
  const start = route.indexOf("router.patch('/:channelId/posts/:postId/comments/:commentId'");
  const end = route.indexOf("router.delete('/:channelId/posts/:postId/comments/:commentId'", start);
  assert.ok(start >= 0 && end > start, 'comment edit route should exist before delete route');
  const handler = route.slice(start, end);
  assert.match(handler, /Comment must be 1–1000 characters/);
  assert.match(handler, /existing\.user_id !== req\.user\.id/);
  assert.match(handler, /Only the comment author can edit this comment/);
  assert.match(handler, /updated_at: new Date\(\)\.toISOString\(\)/);
  assert.match(handler, /\.eq\('user_id', req\.user\.id\)/);
});
