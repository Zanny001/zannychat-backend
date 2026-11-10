const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sql = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261110193028_private_avatar_compatibility_stage_0071.sql'), 'utf8');

test('private avatar stage is additive and preserves all legacy avatar links and public access', () => {
  assert.match(sql, /add column if not exists avatar_path text/i);
  assert.match(sql, /values \('private-avatars', 'private-avatars', false/i);
  assert.match(sql, /do update set\s+public = false/i);
  assert.match(sql, /Deliberately do not revoke profiles SELECT/i);
  assert.doesNotMatch(sql, /drop policy[^;]*avatars/i);
  assert.doesNotMatch(sql, /delete from storage\.objects|truncate|drop table|alter table public\.profiles/i);
});

test('private avatar reads are gated by visibility, contact relationship and bidirectional blocks', () => {
  assert.match(sql, /function public\.can_view_profile_avatar\(p_owner_id uuid\)/i);
  assert.match(sql, /photo_visibility/i);
  assert.match(sql, /v_visibility = 'nobody'/i);
  assert.match(sql, /v_visibility = 'contacts' and v_is_contact/i);
  assert.match(sql, /public\.blocked_users/i);
  assert.match(sql, /bucket_id = 'private-avatars'[\s\S]*public\.can_view_profile_avatar/i);
});

test('private avatar writes are restricted to the authenticated owner folder', () => {
  for (const policy of ['Private avatar owner upload','Private avatar owner update','Private avatar owner delete']) {
    assert.ok(sql.includes(policy), `missing ${policy}`);
  }
  assert.match(sql, /storage\.foldername\(name\)\)\[1\] = \(select auth\.uid\(\)\)::text/i);
});
