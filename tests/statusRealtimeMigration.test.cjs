const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const migration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/0032_status_updates_realtime.sql'), 'utf8');

test('status realtime migration adds status updates to publication idempotently', () => {
  assert.match(migration, /pg_publication_tables/i);
  assert.match(migration, /pubname = 'supabase_realtime'/i);
  assert.match(migration, /alter publication supabase_realtime add table public\.status_updates/i);
});

test('status realtime migration leaves row-level security as the access boundary', () => {
  assert.match(migration, /RLS on status_updates remains the authority/i);
  assert.doesNotMatch(migration, /disable row level security/i);
  assert.doesNotMatch(migration, /grant .*status_updates/i);
});
