const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migrationsDir = path.join(__dirname, '..', 'supabase', 'migrations');
const readMigration = (name) => fs.readFileSync(path.join(migrationsDir, name), 'utf8');

test('foreign-key index migration only adds indexes for uncovered public foreign keys', () => {
  const sql = readMigration('20261109224226_index_uncovered_foreign_keys.sql');
  assert.match(sql, /contype\s*=\s*'f'/i);
  assert.match(sql, /ns\.nspname\s*=\s*'public'/i);
  assert.match(sql, /indisvalid/i);
  assert.match(sql, /indisready/i);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS/i);
  assert.doesNotMatch(sql, /DROP INDEX|DROP CONSTRAINT|ALTER TABLE/i);
});

test('status audience policy consolidation preserves owner writes and recipient visibility', () => {
  const sql = readMigration('20261109224248_merge_status_audience_recipient_select_policies.sql');
  assert.match(sql, /DROP POLICY IF EXISTS "Recipients can identify active statuses shared with them"/);
  assert.match(sql, /DROP POLICY IF EXISTS "Status owner manages audience recipients"/);
  assert.match(sql, /FOR SELECT[\s\S]*owner_id = \(SELECT auth\.uid\(\)\)[\s\S]*can_view_status/);
  assert.match(sql, /FOR INSERT[\s\S]*audience = 'selected_contacts'/);
  assert.match(sql, /FOR UPDATE[\s\S]*USING \(owner_id = \(SELECT auth\.uid\(\)\)\)/);
  assert.match(sql, /FOR DELETE[\s\S]*USING \(owner_id = \(SELECT auth\.uid\(\)\)\)/);
});

test('RLS initplan migration only hoists auth.uid calls and does not relax predicates', () => {
  const sql = readMigration('20261109224348_optimize_auth_rls_initplans.sql');
  assert.equal((sql.match(/ALTER POLICY/g) || []).length, 19);
  assert.equal((sql.match(/\(SELECT auth\.uid\(\)\)/g) || []).length >= 19, true);
  assert.doesNotMatch(sql, /DROP POLICY|CREATE POLICY|DISABLE ROW LEVEL SECURITY|GRANT |REVOKE /i);
});
