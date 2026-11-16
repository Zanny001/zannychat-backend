const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migration = fs.readFileSync(
  path.join(__dirname, '../supabase/migrations/20261115102211_20261115150000_fix_chat_media_extension_guard.sql'),
  'utf8',
);

test('chat media extension guard uses a single regex escape for the filename dot', () => {
  assert.ok(migration.includes("p_object_name !~* '\\.(html?"));
  assert.ok(!migration.includes("p_object_name !~* '\\\\.(html?"));
});

test('chat media extension guard still requires an authenticated conversation member', () => {
  assert.match(migration, /auth\.uid\(\) IS NOT NULL/i);
  assert.match(migration, /public\.conversation_participants AS cp/i);
  assert.match(migration, /cp\.conversation_id::text = \(storage\.foldername\(p_object_name\)\)\[1\]/i);
  assert.match(migration, /cp\.user_id = auth\.uid\(\)/i);
  assert.match(migration, /REVOKE ALL ON FUNCTION private\.can_upload_chat_media\(text\) FROM PUBLIC, anon/i);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION private\.can_upload_chat_media\(text\) TO authenticated/i);
});
