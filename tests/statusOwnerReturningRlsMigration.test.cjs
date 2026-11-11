const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sql = fs.readFileSync(
  path.join(__dirname, '../supabase/migrations/20261111042241_status_owner_select_returning_rls.sql'),
  'utf8',
);

test('active status authors can read their own rows for INSERT RETURNING', () => {
  assert.match(sql, /CREATE POLICY "Authorized viewers can read active statuses"/i);
  assert.match(sql, /FOR SELECT\s+TO authenticated/i);
  assert.match(sql, /user_id = \(SELECT auth\.uid\(\)\)/i);
});

test('other viewers remain subject to the existing audience authorization function', () => {
  assert.match(sql, /OR public\.can_view_status\(id, \(SELECT auth\.uid\(\)\)\)/i);
});

test('expired statuses remain hidden from every viewer', () => {
  assert.match(sql, /expires_at > now\(\)/i);
});

test('migration replaces only the status SELECT policy', () => {
  assert.match(sql, /DROP POLICY IF EXISTS "Authorized viewers can read active statuses"/i);
  assert.doesNotMatch(sql, /CREATE POLICY.*FOR (INSERT|UPDATE|DELETE)/i);
  assert.doesNotMatch(sql, /DROP POLICY.*(INSERT|UPDATE|DELETE)/i);
});
