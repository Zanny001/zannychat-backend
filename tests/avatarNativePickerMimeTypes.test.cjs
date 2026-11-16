const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migration = fs.readFileSync(
  path.join(__dirname, '../supabase/migrations/20261115103508_20261115180000_avatar_native_picker_mime_types.sql'),
  'utf8',
);

test('public and private avatar buckets accept HEIC/HEIF from native pickers', () => {
  assert.match(migration, /WHERE id IN \('avatars', 'private-avatars'\)/i);
  for (const mime of ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']) {
    assert.ok(migration.includes(`'${mime}'`), `missing MIME type ${mime}`);
  }
});

test('avatar native MIME compatibility does not change bucket privacy, size limits, or policies', () => {
  assert.doesNotMatch(migration, /public\s*=|file_size_limit\s*=|CREATE POLICY|DROP POLICY/i);
});
