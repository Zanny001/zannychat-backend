const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migration = fs.readFileSync(
  path.join(__dirname, '../supabase/migrations/20261115200000_status_media_native_path_guard.sql'),
  'utf8',
);

test('status media upload guard permits only supported photo and video extensions', () => {
  for (const ext of ['jpg', 'png', 'webp', 'gif', 'heic', 'heif', 'mp4', 'mov']) {
    assert.ok(migration.includes(`'${ext}'`), `missing allowed extension ${ext}`);
  }
  for (const ext of ['svg', 'html', 'webm', '3gp', 'exe']) {
    assert.ok(!migration.includes(`'${ext}'`), `unexpected allowed extension ${ext}`);
  }
});

test('status media guard retains authenticated owner, row, expiry, and media-kind checks', () => {
  assert.match(migration, /auth\.uid\(\) is not null/);
  assert.match(migration, /s\.user_id = auth\.uid\(\)/);
  assert.match(migration, /s\.media_path = p_object_name/);
  assert.match(migration, /s\.expires_at > now\(\)/);
  assert.match(migration, /SECURITY DEFINER/);
  assert.match(migration, /SET search_path TO 'pg_catalog'/);
});
