const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '0062_revoke_client_public_schema_create.sql'), 'utf8');

test('public schema creation is revoked from PUBLIC, anon, and authenticated roles', () => {
  assert.match(sql, /revoke\s+create\s+on\s+schema\s+public\s+from\s+public\s*,\s*anon\s*,\s*authenticated/i);
  assert.match(sql, /SECURITY\s+DEFINER/i);
  assert.doesNotMatch(sql, /grant\s+create\s+on\s+schema\s+public\s+to\s+(public|anon|authenticated)/i);
});
