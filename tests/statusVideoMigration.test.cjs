const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const migration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/0027_video_statuses.sql'), 'utf8');

test('video status migration keeps storage private and restricts MP4 size/type', () => {
  assert.match(migration, /where id = 'status-media'/i);
  assert.match(migration, /public = false/i);
  assert.match(migration, /file_size_limit = 52428800/i);
  assert.match(migration, /'video\/mp4'/i);
  assert.match(migration, /between 1 and 10485760/i);
  assert.match(migration, /between 1 and 52428800/i);
});
test('video storage policies require active owned status and exact video path', () => {
  assert.match(migration, /s\.user_id = auth\.uid\(\)/i);
  assert.match(migration, /s\.media_kind in \('image','video'\)/i);
  assert.match(migration, /'\/video\.mp4'/i);
  assert.match(migration, /s\.expires_at > now\(\)/i);
});
test('video media reads preserve contacts visibility and expiry checks', () => {
  assert.match(migration, /s\.audience = 'contacts'/i);
  assert.match(migration, /conversation_participants/i);
  assert.match(migration, /s\.media_path = name/i);
});
test('status row path update policy binds video to owner and row id', () => {
  assert.match(migration, /media_kind = 'video' and media_path = user_id::text \|\| '\/' \|\| id::text \|\| '\/video\.mp4'/i);
});
