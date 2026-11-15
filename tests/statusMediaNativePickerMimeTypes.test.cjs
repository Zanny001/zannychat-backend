const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migration = fs.readFileSync(
  path.join(__dirname, '../supabase/migrations/20261115170000_status_media_native_picker_mime_types.sql'),
  'utf8',
);

test('status-media remains private and accepts common Android/iOS image and video picker formats', () => {
  assert.match(migration, /WHERE id = 'status-media'/i);
  for (const mime of [
    'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif',
    'video/mp4', 'video/quicktime', 'video/webm', 'video/3gpp',
  ]) assert.ok(migration.includes(`'${mime}'`), `missing MIME type ${mime}`);
  assert.doesNotMatch(migration, /SET public\s*=\s*true/i);
});

test('status-media does not alter the existing 50 MiB size limit or authorization policies', () => {
  assert.doesNotMatch(migration, /file_size_limit\s*=/i);
  assert.doesNotMatch(migration, /CREATE POLICY|DROP POLICY/i);
});
