const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migrationPath = path.join(__dirname, '../supabase/migrations/20261115101500_chat_media_upload_size_limit.sql');
const migration = fs.readFileSync(migrationPath, 'utf8');

test('chat-media Storage bucket has an explicit 25 MiB server-side upload limit', () => {
  assert.match(migration, /storage\.buckets/);
  assert.match(migration, /file_size_limit\s*=\s*26214400/);
  assert.match(migration, /WHERE id\s*=\s*'chat-media'/);
  assert.match(migration, /RAISE EXCEPTION/);
});
