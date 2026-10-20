const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const migration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/0022_status_media.sql'), 'utf8');

test('photo status migration keeps storage private and bounds image uploads', () => {
  assert.match(migration, /values \('status-media', 'status-media', false/i);
  assert.match(migration, /file_size_limit[\s\S]*10485760/i);
  assert.match(migration, /image\/jpeg[\s\S]*image\/png[\s\S]*image\/webp/i);
  assert.match(migration, /media_kind = 'image'/i);
});

test('photo storage upload and reads are scoped to owner and status visibility', () => {
  assert.match(migration, /Status media owner uploads[\s\S]*with check/i);
  assert.match(migration, /s\.user_id = auth\.uid\(\)/i);
  assert.match(migration, /Status media visible to authorized viewers[\s\S]*for select/i);
  assert.match(migration, /s\.audience = 'contacts'/i);
  assert.match(migration, /revoke all on storage\.objects from anon/i);
});

test('photo statuses retain expiry and author-only updates', () => {
  assert.match(migration, /expires_at <= created_at \+ interval '24 hours'/i);
  assert.match(migration, /Users can update own media status path[\s\S]*using \(user_id = \(select auth\.uid\(\)\)\)/i);
  assert.match(migration, /grant update on public\.status_updates to authenticated/i);
});
