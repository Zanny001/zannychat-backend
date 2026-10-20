const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const migration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/0019_group_administration.sql'), 'utf8');
const route = fs.readFileSync(path.join(__dirname, '../src/routes/conversations.js'), 'utf8');
test('group migration adds an admin flag and backfills an initial admin', () => {
  assert.match(migration, /add column if not exists is_admin boolean not null default false/i);
  assert.match(migration, /row_number\(\) over \(partition by cp\.conversation_id order by cp\.joined_at/i);
  assert.match(migration, /where c\.is_group = true/i);
});
test('group administration checks verified actor membership and admin role', () => {
  assert.match(route, /router\.patch\('\/:conversationId\/members\/:memberId\/admin'/);
  assert.match(route, /if \(!actor\.is_admin\) return res\.status\(403\)/);
  assert.match(route, /router\.delete\('\/:conversationId\/members\/:memberId'/);
});
test('group creation marks creator admin and other selected members non-admin', () => {
  assert.match(route, /user_id: req\.user\.id, is_admin: true/);
  assert.match(route, /is_admin: false/);
});
test('last group admin cannot leave without promoting another admin', () => {
  assert.match(route, /Promote another admin before leaving the group/);
  assert.match(route, /\(count \|\| 0\) <= 1/);
});
test('group roster endpoint checks group membership before returning profiles', () => {
  assert.match(route, /router\.get\('\/:conversationId\/members'/);
  assert.match(route, /if \(!actor\) return res\.status\(403\)\.json\(\{ error: 'You are not a group member' \}\)/);
  assert.match(route, /profiles\(id,name,avatar_url\)/);
});
