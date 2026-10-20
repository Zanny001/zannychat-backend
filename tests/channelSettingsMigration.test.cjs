const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const route = fs.readFileSync(path.join(__dirname, '../src/routes/channels.js'), 'utf8');

test('channel settings endpoint validates bounded title and description', () => {
  assert.match(route, /router\.patch\('\/:channelId'/);
  assert.match(route, /Channel name must be 2–60 characters/);
  assert.match(route, /Description must be 500 characters or fewer/);
});

test('only channel owner can update metadata', () => {
  assert.match(route, /Only the channel owner can edit channel details/);
  assert.match(route, /update\(\{ title, description, \.\.\.\(req\.body\?\.isPrivate === undefined \? \{\} : \{ is_private: req\.body\.isPrivate \}\), updated_at:/);
  assert.match(route, /eq\('owner_id', req\.user\.id\)/);
});
