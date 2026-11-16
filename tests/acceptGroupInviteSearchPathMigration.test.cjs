const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migration = fs.readFileSync(
  path.join(__dirname, '../supabase/migrations/20261115140156_harden_accept_group_invite_search_path.sql'),
  'utf8',
);

test('applied group invite SECURITY DEFINER RPC pins its search path', () => {
  assert.match(migration, /^ALTER FUNCTION public\.accept_group_invite\(text, uuid\) SET search_path = pg_catalog, public;$/i);
});
