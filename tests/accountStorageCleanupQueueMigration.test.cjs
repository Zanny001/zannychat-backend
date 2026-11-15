const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migration = fs.readFileSync(
  path.join(__dirname, '../supabase/migrations/20261115103000_account_storage_cleanup_jobs.sql'),
  'utf8',
);

test('account storage cleanup queue survives Auth deletion and is service-role-only', () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.account_storage_cleanup_jobs/i);
  assert.doesNotMatch(migration, /REFERENCES auth\.users/i);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/i);
  assert.match(migration, /REVOKE ALL ON TABLE public\.account_storage_cleanup_jobs FROM PUBLIC, anon, authenticated/i);
  assert.match(migration, /GRANT ALL ON TABLE public\.account_storage_cleanup_jobs TO service_role/i);
  assert.match(migration, /next_attempt_at, created_at/i);
  assert.match(migration, /status text NOT NULL DEFAULT 'held'/i);
  assert.match(migration, /CHECK \(status IN \('held', 'pending'\)\)/i);
});
