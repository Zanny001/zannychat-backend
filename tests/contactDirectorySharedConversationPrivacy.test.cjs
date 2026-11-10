const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migration = fs.readFileSync(
  path.join(__dirname, '../supabase/migrations/20261110193118_enforce_contact_directory_shared_conversation_20261110160000.sql'),
  'utf8',
);

function contactDirectoryDefinition(sql) {
  const start = sql.search(/create\s+(?:or\s+replace\s+)?function\s+public\.get_contact_directory\s*\(\s*p_user_id\s+uuid\s*\)/i);
  assert.notEqual(start, -1, 'targeted contact-directory RPC must be defined');
  const end = sql.indexOf('$function$;', start);
  assert.notEqual(end, -1, 'contact-directory function body must terminate');
  return sql.slice(start, end);
}

test('contact directory and QR-target lookup require a shared conversation', () => {
  const body = contactDirectoryDefinition(migration);
  assert.match(body, /exists\s*\([\s\S]*?from\s+public\.conversation_participants\s+as\s+viewer_membership[\s\S]*?join\s+public\.conversation_participants\s+as\s+target_membership[\s\S]*?on\s+target_membership\.conversation_id\s*=\s*viewer_membership\.conversation_id[\s\S]*?viewer_membership\.user_id\s*=\s*auth\.uid\(\)[\s\S]*?target_membership\.user_id\s*=\s*p\.id/i);
});

test('targeted lookup remains bound to the requested profile and excludes self', () => {
  const body = contactDirectoryDefinition(migration);
  assert.match(body, /p_user_id\s+is\s+null\s+or\s+p\.id\s*=\s*p_user_id/i);
  assert.match(body, /p\.id\s*<>\s*auth\.uid\(\)/i);
});

test('bidirectional blocks still suppress directory and QR results', () => {
  const body = contactDirectoryDefinition(migration);
  assert.match(body, /b\.blocker_id\s*=\s*auth\.uid\(\)\s+and\s+b\.blocked_id\s*=\s*p\.id/i);
  assert.match(body, /b\.blocker_id\s*=\s*p\.id\s+and\s+b\.blocked_id\s*=\s*auth\.uid\(\)/i);
});

test('profile visibility, photo visibility, and online-status preferences are enforced', () => {
  const body = contactDirectoryDefinition(migration);
  assert.match(body, /left\s+join\s+public\.profile_details\s+as\s+d\s+on\s+d\.user_id\s*=\s*p\.id/i);
  assert.match(body, /coalesce\(d\.profile_visibility,\s*'everyone'\)\s*<>\s*'nobody'/i);
  assert.match(body, /coalesce\(d\.photo_visibility,\s*'everyone'\)\s*=\s*'nobody'\s+then\s+null/i);
  assert.match(body, /coalesce\(d\.show_online_status,\s*true\)/i);
});

test('migration safely replaces both RPC signatures and preserves authenticated/service-role access', () => {
  assert.match(migration, /drop\s+function\s+if\s+exists\s+public\.get_contact_directory\(\)\s*;\s*drop\s+function\s+if\s+exists\s+public\.get_contact_directory\(uuid\)/i);
  assert.match(migration, /security\s+definer/i);
  assert.match(migration, /set\s+search_path\s*=\s*''/i);
  assert.match(migration, /revoke\s+all\s+on\s+function\s+public\.get_contact_directory\(uuid\)\s+from\s+public,\s*anon/i);
  assert.match(migration, /grant\s+execute\s+on\s+function\s+public\.get_contact_directory\(uuid\)\s+to\s+authenticated,\s*service_role/i);
  assert.match(migration, /grant\s+execute\s+on\s+function\s+public\.get_contact_directory\(\)\s+to\s+authenticated,\s*service_role/i);
});
