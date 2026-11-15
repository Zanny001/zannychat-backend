const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sql = fs.readFileSync(
  path.join(__dirname, '../supabase/migrations/20261115111000_grant_profile_username_update.sql'),
  'utf8',
);

test('authenticated users can update only the username column through the existing owner-only RLS policy', () => {
  assert.match(sql, /grant update \(username\) on table public\.profiles to authenticated/i);
  assert.doesNotMatch(sql, /grant update on table public\.profiles/i);
  assert.doesNotMatch(sql, /create policy|drop policy|using\s*\(\s*true/i);
});
