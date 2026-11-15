const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migration = fs.readFileSync(
  path.join(__dirname, '../supabase/migrations/20261115120000_private_avatar_visibility_cutover.sql'),
  'utf8',
);

test('avatar authorization enforces profile visibility as well as photo visibility', () => {
  assert.match(migration, /v_profile_visibility text/i);
  assert.match(migration, /v_photo_visibility = 'nobody' OR v_profile_visibility = 'nobody'/i);
  assert.match(migration, /v_photo_visibility = 'contacts' OR v_profile_visibility = 'contacts'/i);
  assert.match(migration, /NOT v_is_contact/i);
  assert.match(migration, /blocked_id = p_user_id/i);
  assert.match(migration, /blocked_id = v_viewer/i);
});

test('avatar path batch RPC requires authentication and bounds caller-supplied IDs', () => {
  assert.match(migration, /get_visible_profile_avatar_paths\(p_user_ids uuid\[\]\)/i);
  assert.match(migration, /IF v_viewer IS NULL THEN[\s\S]*?Authentication required/i);
  assert.match(migration, /cardinality\(p_user_ids\), 0\) > 500/i);
  assert.match(migration, /p\.id = ANY\(COALESCE\(p_user_ids, ARRAY\[\]::uuid\[\]\)\)/i);
});

test('private object paths are returned only when the caller passes avatar authorization', () => {
  assert.match(migration, /CASE[\s\S]*?WHEN public\.can_view_profile_avatar\(p\.id\) THEN d\.avatar_path[\s\S]*?ELSE NULL/i);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.get_visible_profile_avatar_paths\(uuid\[\]\) FROM PUBLIC, anon/i);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.get_visible_profile_avatar_paths\(uuid\[\]\) TO authenticated/i);
  assert.match(migration, /SET search_path = ''/i);
});
