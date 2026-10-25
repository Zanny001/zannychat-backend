const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('comment reactions require subscription for non-owner participants', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/routes/channels.js'), 'utf8');
  const start = source.indexOf("router.put('/:channelId/posts/:postId/comments/:commentId/reaction'");
  const end = source.indexOf("router.delete('/:channelId/posts/:postId/comments/:commentId'", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const route = source.slice(start, end);
  assert.match(route, /channel\.owner_id !== req\.user\.id/);
  assert.match(route, /from\('channel_subscriptions'\)/);
  assert.match(route, /if \(!subscription\) return res\.status\(403\)/);
  assert.match(route, /requireChannelAccess\(res, channel, req\.user\.id\)/);
});

test('comment reaction permission failures do not expose database errors', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/routes/channels.js'), 'utf8');
  assert.match(source, /Unable to check comment reaction permissions/);
  assert.match(source, /Subscribe to the channel before reacting to comments/);
});


test('editing comments requires current subscription for non-owner participants', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/routes/channels.js'), 'utf8');
  const start = source.indexOf("router.patch('/:channelId/posts/:postId/comments/:commentId'");
  const end = source.indexOf("router.put('/:channelId/posts/:postId/comments/:commentId/reaction'", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const route = source.slice(start, end);
  assert.match(route, /requireChannelAccess\(res, channel, req\.user\.id\)/);
  assert.match(route, /channel\.owner_id !== req\.user\.id/);
  assert.match(route, /from\('channel_subscriptions'\)/);
  assert.match(route, /if \(!subscription\) return res\.status\(403\)/);
  assert.match(route, /Subscribe to the channel before editing comments/);
});

test('comment edit permission checks fail closed without exposing database errors', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/routes/channels.js'), 'utf8');
  assert.match(source, /Unable to check comment edit permissions/);
});
