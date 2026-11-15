const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sql = fs.readFileSync(
  path.join(__dirname, '../supabase/migrations/20261115092236_fix_contact_directory_avatar_visibility.sql'),
  'utf8',
);

test('legacy contact directory uses the shared photo visibility predicate', () => {
  assert.match(sql, /CASE\s+WHEN public\.can_view_profile_avatar\(p\.id\) THEN p\.avatar_url\s+ELSE NULL/i);
  assert.doesNotMatch(sql, /photo_visibility[^;]*= 'nobody'/i);
});

test('contact directory remains authenticated, conversation-scoped and block-aware', () => {
  assert.match(sql, /auth\.uid\(\) is not null/i);
  assert.match(sql, /viewer_membership\.user_id = auth\.uid\(\)/i);
  assert.match(sql, /target_membership\.user_id = p\.id/i);
  assert.match(sql, /b\.blocker_id = auth\.uid\(\) and b\.blocked_id = p\.id/i);
  assert.match(sql, /b\.blocker_id = p\.id and b\.blocked_id = auth\.uid\(\)/i);
  assert.match(sql, /grant execute on function public\.get_contact_directory\(uuid\) to authenticated/i);
});
