const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const migrationPath = path.join(
  root,
  'supabase/migrations/0015_revoke_anon_application_privileges.sql'
);

const migration = fs.readFileSync(migrationPath, 'utf8');

const expectedTables = [
  'blocked_users',
  'conversation_participants',
  'conversations',
  'ledger_entries',
  'message_reactions',
  'messages',
  'profiles',
  'push_tokens',
  'reports',
  'wallets',
];

test('anonymous privilege migration covers every intended application table', () => {
  for (const table of expectedTables) {
    assert.match(
      migration,
      new RegExp(`['"]${table}['"]`),
      `Missing table: ${table}`
    );
  }
});

test('anonymous privilege migration revokes table and column grants only from anon', () => {
  assert.match(
    migration,
    /REVOKE ALL PRIVILEGES ON TABLE public\.%I FROM anon/i
  );

  assert.match(
    migration,
    /REVOKE %s \(%I\) ON TABLE public\.%I FROM anon/i
  );

  assert.doesNotMatch(migration, /\bGRANT\b/i);
  assert.doesNotMatch(migration, /\bCREATE\s+POLICY\b|\bDROP\s+POLICY\b|\bALTER\s+POLICY\b/i);
  assert.doesNotMatch(migration, /\bALTER\s+DEFAULT\s+PRIVILEGES\b/i);
});

test('migration does not alter authenticated or service_role grants', () => {
  assert.doesNotMatch(migration, /\bFROM\s+(?:authenticated|service_role)\b/i);
  assert.doesNotMatch(migration, /\bTO\s+(?:authenticated|service_role)\b/i);
});

test('migration safely skips application tables that do not exist', () => {
  assert.match(migration, /to_regclass\(/i);
});
