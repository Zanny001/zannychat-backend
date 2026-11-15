const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sql = fs.readFileSync(
  path.join(__dirname, '../supabase/migrations/20261115110000_fix_conversation_avatar_visibility.sql'),
  'utf8',
);

test('conversation directory delegates avatar visibility to the shared privacy predicate', () => {
  assert.match(sql, /CASE\\s+WHEN public\\.can_view_profile_avatar\\(p\\.id\\) THEN p\\.avatar_url\\s+ELSE NULL/i);
  assert.doesNotMatch(sql, /photo_visibility[^;]*= 'nobody'/i);
});

test('conversation directory retains conversation membership, authentication and bidirectional block guards', () => {
  assert.match(sql, /v_viewer uuid := auth\\.uid\\(\\)/i);
  assert.match(sql, /p\\.id = any\\(coalesce\\(p_user_ids, array\\[\\]::uuid\\[\\]\\)\\)/i);
  assert.match(sql, /mine\\.user_id = v_viewer[\\s\\S]*?theirs\\.user_id = p\\.id/i);
  assert.match(sql, /b\\.blocker_id = v_viewer and b\\.blocked_id = p\\.id/i);
  assert.match(sql, /b\\.blocker_id = p\\.id and b\\.blocked_id = v_viewer/i);
  assert.match(sql, /revoke all on function public\\.get_conversation_profile_directory\\(uuid\\[\\]\\) from public, anon/i);
  assert.match(sql, /grant execute on function public\\.get_conversation_profile_directory\\(uuid\\[\\]\\) to authenticated/i);
});
