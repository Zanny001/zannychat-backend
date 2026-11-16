const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migration = fs.readFileSync(
  path.join(__dirname, '../supabase/migrations/20261115101425_20261115130000_chat_media_safe_mime_types.sql'),
  'utf8',
);

test('chat-media remains private and accepts supported media and downloadable document MIME types', () => {
  assert.match(migration, /WHERE id = 'chat-media'/i);
  assert.match(migration, /allowed_mime_types = ARRAY\[/i);
  for (const mime of [
    'image/jpeg', 'image/png', 'image/webp', 'video/mp4',
    'audio/m4a', 'audio/mp4', 'application/pdf',
    'application/octet-stream', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'text/plain', 'text/csv',
  ]) assert.ok(migration.includes(`'${mime}'`), `missing allowed MIME type ${mime}`);
});

test('chat-media upload authorization still requires an active conversation participant', () => {
  assert.match(migration, /auth\.uid\(\) IS NOT NULL/i);
  assert.match(migration, /public\.conversation_participants AS cp/i);
  assert.match(migration, /cp\.conversation_id::text = \(storage\.foldername\(p_object_name\)\)\[1\]/i);
  assert.match(migration, /cp\.user_id = auth\.uid\(\)/i);
});

test('chat-media blocks active web, script, and executable extensions even when MIME is mislabeled', () => {
  assert.match(migration, /p_object_name !~\* '\\\\?\./i);
  for (const ext of ['html?', 'svg', 'js', 'exe', 'dll', 'msi', 'bat', 'cmd', 'sh', 'ps1', 'apk', 'php']) {
    assert.ok(migration.includes(ext), `missing blocked extension ${ext}`);
  }
  assert.match(migration, /REVOKE ALL ON FUNCTION private\.can_upload_chat_media\(text\) FROM PUBLIC, anon/i);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION private\.can_upload_chat_media\(text\) TO authenticated/i);
});
