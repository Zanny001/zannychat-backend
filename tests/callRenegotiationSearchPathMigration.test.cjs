const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261114173749_harden_call_renegotiation_search_path_20261114195000.sql'), 'utf8');

test('call renegotiation trigger runs with an empty search path and qualified relations', () => {
  assert.match(migration, /SET search_path = ''/);
  assert.match(migration, /FROM public\.call_sessions/);
  assert.match(migration, /FROM public\.call_signals/);
  assert.match(migration, /auth\.uid\(\)/);
  assert.match(migration, /pg_catalog\.pg_advisory_xact_lock/);
  assert.match(migration, /pg_catalog\.hashtextextended/);
});
