const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const auditPath = path.join(__dirname, '../supabase/audits/security_definer_inventory.sql');
const sql = fs.readFileSync(auditPath, 'utf8').toLowerCase();

test('read-only SECURITY DEFINER inventory reports search_path configuration and caller grants', () => {
  assert.match(sql, /where p\.prosecdef/);
  assert.match(sql, /p\.proconfig/);
  assert.match(sql, /has_function_privilege\('anon'/);
  assert.match(sql, /has_function_privilege\('authenticated'/);
  assert.match(sql, /has_function_privilege\('service_role'/);
  assert.match(sql, /pg_get_function_identity_arguments/);
});

test('inventory detects unpinned search_path and effective PUBLIC execute grants', () => {
  assert.match(sql, /search_path_not_pinned/);
  assert.match(sql, /aclexplode\(/);
  assert.match(sql, /acl\.grantee = 0/);
  assert.match(sql, /public_can_execute/);
});

test('triage prioritizes unpinned search_path combined with PUBLIC or anonymous execution', () => {
  assert.match(sql, /critical review: unpinned search_path and public execute/);
  assert.match(sql, /high review: unpinned search_path and anon execution/);
  assert.match(sql, /order by search_path_not_pinned desc/);
});

test('SECURITY DEFINER inventory audit does not mutate database state', () => {
  const withoutComments = sql.replace(/^\s*--.*$/gm, '');
  assert.doesNotMatch(withoutComments, /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke)\s+/i);
  assert.match(withoutComments.trim(), /^with definer_inventory as \(/);
  assert.match(withoutComments, /\bselect\b[\s\S]*\bfrom definer_inventory\b/);
});
