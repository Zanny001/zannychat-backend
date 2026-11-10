const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sql = fs.readFileSync(
  path.join(__dirname, '../supabase/migrations/20261110193055_private_profile_cover_compatibility_0073.sql'),
  'utf8',
);

test('private cover migration is additive and preserves legacy public objects', () => {
  assert.match(sql, /add column if not exists cover_path text/i);
  assert.doesNotMatch(sql, /delete from storage\.objects|truncate|drop table|drop bucket/i);
  assert.doesNotMatch(sql, /getPublicUrl|avatars'\s*,\s*true/i);
});

test('public profile projection never returns permanent cover URLs or private paths', () => {
  assert.match(sql, /to_jsonb\(v_details\)\s*-\s*'user_id'\s*-\s*'cover_image_url'\s*-\s*'cover_path'/i);
  assert.doesNotMatch(sql, /'cover_image_url'\s*,/i);
  assert.doesNotMatch(sql, /'cover_path'\s*,/i);
});

test('cover resolver requires both profile and photo visibility authorization', () => {
  assert.match(sql, /function public\.get_visible_profile_cover_path\(p_user_id uuid\)/i);
  assert.match(sql, /public\.can_view_profile_avatar\(p_user_id\)/i);
  assert.match(sql, /public\.get_public_profile_details\(p_user_id\)\s*<>\s*'\{\}'::jsonb/i);
  assert.match(sql, /revoke all on function public\.get_visible_profile_cover_path\(uuid\) from public, anon/i);
  assert.match(sql, /grant execute on function public\.get_visible_profile_cover_path\(uuid\) to authenticated/i);
});
