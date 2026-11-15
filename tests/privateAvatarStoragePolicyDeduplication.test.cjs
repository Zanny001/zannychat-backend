const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migration = fs.readFileSync(
  path.join(__dirname, '../supabase/migrations/20261115160000_dedupe_private_avatar_storage_policies.sql'),
  'utf8',
);

test('duplicate private-avatar policies are removed while canonical owner/viewer policies remain', () => {
  for (const name of [
    'Private avatar owner delete',
    'Private avatar owner update',
    'Private avatar owner upload',
    'Private avatar visible by profile preference',
  ]) {
    assert.ok(migration.includes(`DROP POLICY IF EXISTS "${name}" ON storage.objects`));
  }
  assert.ok(!migration.includes('DROP POLICY IF EXISTS "Private profile media'));
});
