const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const migration = fs.readFileSync(path.join(root, 'supabase/migrations/0039_group_metadata.sql'), 'utf8');
const routes = fs.readFileSync(path.join(root, 'src/routes/conversations.js'), 'utf8');

test('group metadata migration adds bounded optional fields without changing existing group defaults', () => {
  assert.match(migration, /add column if not exists group_topic text not null default ''/i);
  assert.match(migration, /add column if not exists group_description text not null default ''/i);
  assert.match(migration, /char_length\(group_topic\) <= 80/i);
  assert.match(migration, /char_length\(group_description\) <= 500/i);
  assert.match(migration, /if not exists/i);
});

test('group metadata read requires membership and reports admin capability from the server', () => {
  assert.match(routes, /router\.get\('\/:conversationId\/metadata'/);
  assert.match(routes, /Only group admins can edit group metadata/);
  assert.match(routes, /canEdit: Boolean\(membership\.is_admin\)/);
});

test('group metadata writes validate limits and verify admin role server-side', () => {
  assert.match(routes, /router\.patch\('\/:conversationId\/metadata'/);
  assert.match(routes, /topic\.length > 80/);
  assert.match(routes, /description\.length > 500/);
  assert.match(routes, /if \(!actor\.is_admin\) return res\.status\(403\)/);
  assert.match(routes, /group_topic: topic, group_description: description/);
});

test('group metadata updates optionally rename the group with bounded non-empty names', () => {
  assert.match(routes, /const name = req\.body\?\.name === undefined/);
  assert.match(routes, /Group name must be between 1 and 80 characters/);
  assert.match(routes, /if \(name !== undefined\) changes\.name = name/);
});
