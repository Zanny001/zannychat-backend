const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migration = fs.readFileSync(
  path.join(__dirname, '../supabase/migrations/20261115143129_resolve_contact_directory_rpc_ambiguity.sql'),
  'utf8',
);

test('contact directory RPC reconciliation removes only the legacy zero-argument overload', () => {
  assert.ok(migration.includes('DROP FUNCTION IF EXISTS public.get_contact_directory();'));
  assert.equal(
    migration.includes('DROP FUNCTION IF EXISTS public.get_contact_directory(uuid)'),
    false,
  );
});
