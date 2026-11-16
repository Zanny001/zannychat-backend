import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const migration = fs.readFileSync(
  new URL('../supabase/migrations/20261115143129_resolve_contact_directory_rpc_ambiguity.sql', import.meta.url),
  'utf8',
);

test('contact directory RPC reconciliation removes only the legacy zero-argument overload', () => {
  assert.match(
    migration,
    /DROP FUNCTION IF EXISTS public\.get_contact_directory\s*\(\s*\)\s*;/i,
  );
  assert.doesNotMatch(
    migration,
    /DROP FUNCTION[^;]*public\.get_contact_directory\s*\(\s*uuid/i,
  );
});
