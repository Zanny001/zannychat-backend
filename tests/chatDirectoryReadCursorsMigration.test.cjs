const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sql = fs.readFileSync(
  path.join(__dirname, '../supabase/migrations/0075_restore_chat_directory_read_cursors.sql'),
  'utf8',
);

function functionBody(source, signature) {
  const start = source.search(signature);
  assert.notEqual(start, -1, 'expected function signature to exist');
  const end = source.indexOf('$function$;', start);
  assert.notEqual(end, -1, 'expected function body terminator');
  return source.slice(start, end);
}

test('replaces the legacy contact-directory return shape safely before creating both RPC signatures', () => {
  assert.match(sql, /drop\s+function\s+if\s+exists\s+public\.get_contact_directory\(\)\s*;\s*drop\s+function\s+if\s+exists\s+public\.get_contact_directory\(uuid\)/i);
  assert.match(sql, /create\s+function\s+public\.get_contact_directory\(p_user_id uuid\)/i);
  assert.match(sql, /create\s+function\s+public\.get_contact_directory\(\)/i);
  assert.match(sql, /from public\.get_contact_directory\(NULL::uuid\)/i);
});

test('base contact-directory projection excludes self and both block directions', () => {
  const body = functionBody(sql, /create\s+function\s+public\.get_contact_directory\(p_user_id uuid\)/i);
  assert.match(body, /p\.id\s*<>\s*auth\.uid\(\)/i);
  assert.match(body, /not\s+exists\s*\([\s\S]*?from\s+public\.blocked_users\s+as\s+b/i);
  assert.match(body, /b\.blocker_id\s*=\s*auth\.uid\(\)\s+and\s+b\.blocked_id\s*=\s*p\.id/i);
  assert.match(body, /b\.blocker_id\s*=\s*p\.id\s+and\s+b\.blocked_id\s*=\s*auth\.uid\(\)/i);
});

test('read cursor RPC returns only the authenticated user’s own non-null cursors', () => {
  const body = functionBody(sql, /create\s+or\s+replace\s+function\s+public\.get_my_read_cursors\(\)/i);
  assert.match(body, /cp\.user_id\s*=\s*auth\.uid\(\)/i);
  assert.match(body, /cp\.last_read_at\s+is\s+not\s+null/i);
});

test('RPCs use fixed empty search_path and deny public/anonymous execution', () => {
  assert.equal((sql.match(/set search_path = ''/gi) || []).length, 3);
  assert.match(sql, /revoke all on function public\.get_contact_directory\(\) from public, anon/i);
  assert.match(sql, /revoke all on function public\.get_contact_directory\(uuid\) from public, anon/i);
  assert.match(sql, /revoke all on function public\.get_my_read_cursors\(\) from public, anon/i);
});

test('contact-directory RPC access is preserved for authenticated and service-role callers', () => {
  assert.match(sql, /grant execute on function public\.get_contact_directory\(\) to authenticated, service_role/i);
  assert.match(sql, /grant execute on function public\.get_contact_directory\(uuid\) to authenticated, service_role/i);
});
