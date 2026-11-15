const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migration = fs.readFileSync(
  path.join(__dirname, '../supabase/migrations/20261115140000_guard_profile_visibility_transitions.sql'),
  'utf8',
);

test('legacy direct profile_details writes cannot change visibility settings', () => {
  assert.match(migration, /guard_profile_visibility_changes/);
  assert.match(migration, /Use update_my_profile_visibility to change profile visibility/i);
  assert.match(migration, /BEFORE INSERT OR UPDATE OF profile_visibility, photo_visibility/i);
  assert.match(migration, /current_setting\('app\.profile_visibility_update', true\)/i);
});

test('legacy clients cannot publish avatar URLs or upload public avatars for restricted profiles', () => {
  assert.match(migration, /guard_public_avatar_pointer/);
  assert.match(migration, /Public avatar URLs are not allowed for restricted profiles/i);
  assert.match(migration, /can_upload_public_avatar\(p_object_name text\)/i);
  assert.match(migration, /private\.can_upload_public_avatar\(name\)/i);
  assert.match(migration, /Users can upload their own avatars/);
  assert.match(migration, /Users can update their own avatars/);
});

test('visibility RPC is caller-scoped and validates public objects are removed before restriction', () => {
  assert.match(migration, /update_my_profile_visibility\([\s\S]*?p_profile_visibility text,[\s\S]*?p_photo_visibility text/i);
  assert.match(migration, /v_user_id uuid := auth\.uid\(\)/i);
  assert.match(migration, /Remove the public avatar URL before restricting visibility/i);
  assert.match(migration, /Remove all public avatar objects before restricting visibility/i);
  assert.match(migration, /A private avatar copy is required before restricting visibility/i);
  assert.match(migration, /bucket_id = 'private-avatars'/i);
  assert.match(migration, /bucket_id = 'avatars'/i);
});

test('only authenticated users can invoke the visibility RPC', () => {
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.update_my_profile_visibility\(text, text\) FROM PUBLIC, anon/i);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.update_my_profile_visibility\(text, text\) TO authenticated/i);
  assert.match(migration, /REVOKE ALL ON FUNCTION private\.can_upload_public_avatar\(text\) FROM PUBLIC, anon/i);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION private\.can_upload_public_avatar\(text\) TO authenticated/i);
});
