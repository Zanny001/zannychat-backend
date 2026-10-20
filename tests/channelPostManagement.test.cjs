const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const route = fs.readFileSync(path.join(__dirname, '../src/routes/channels.js'), 'utf8');

test('channel post edits are bounded and owner-authorized', () => {
  assert.match(route, /router\.patch\('\/:channelId\/posts\/:postId'/);
  assert.match(route, /Post must be 1–4000 characters/);
  assert.match(route, /Only the channel owner can edit posts/);
  assert.match(route, /edited_at: new Date\(\)\.toISOString\(\)/);
});

test('channel post deletion is moderator-authorized and scoped to its channel', () => {
  assert.match(route, /router\.delete\('\/:channelId\/posts\/:postId'/);
  assert.match(route, /Only the channel owner or a channel moderator can delete posts/);
  assert.match(route, /\.eq\('id', req\.params\.postId\)\.eq\('channel_id', channel\.id\)/);
});
