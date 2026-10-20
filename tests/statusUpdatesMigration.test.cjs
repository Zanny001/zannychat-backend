const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const migration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/0016_text_status_updates.sql'), 'utf8');

test('status migration defines bounded text and a maximum 24-hour lifetime', () => {
  assert.match(migration, /char_length\(btrim\(text\)\) between 1 and 700/i);
  assert.match(migration, /interval '24 hours'/i);
  assert.match(migration, /expires_at > now\(\)/i);
});

test('status migration enables RLS and protects contact/private visibility', () => {
  assert.match(migration, /enable row level security/i);
  assert.match(migration, /audience = 'contacts'/i);
  assert.match(migration, /user_id = \(select auth\.uid\(\)\)/i);
  assert.match(migration, /revoke all on public\.status_updates from anon/i);
  assert.match(migration, /grant select, insert, delete on public\.status_updates to authenticated/i);
});
